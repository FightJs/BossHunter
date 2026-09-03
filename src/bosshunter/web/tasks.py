"""Workbench background task runner."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from threading import Event, Lock, Thread, Timer
from typing import Any, Callable
from uuid import uuid4

from bosshunter.throttle import SendWindowChecker


MODE_LABELS = {
    "full": "运行全流程",
    "collect": "单独采集",
    "score": "单独 AI 评分",
    "rescore": "重新评分",
    "greet": "单独生成招呼语",
    "monitor": "单独监测",
    "deliver": "确认投递",
}

TERMINAL_STATUSES = {"completed", "failed", "stopped"}
ACTIVE_STATUSES = {"running", "stopping", "pausing"}
# Only proactive send tasks stop at the send-window deadline. Standalone
# monitoring must keep watching for HR replies and resume requests all day.
DEADLINE_MODES = {"full", "deliver"}

# Workbench tasks used to share one global active slot.  That made otherwise
# independent work impossible to overlap (for example collecting jobs while
# scoring the jobs already in the database).  Keep the safety boundary at the
# resource level instead: browser-facing tasks remain mutually exclusive,
# scoring runs are serialized with other scoring runs, and greeting generation
# is its own AI/DB lane.  ``full`` reserves every lane because it owns all
# stages of the pipeline over its lifetime.
MODE_RESOURCES = {
    "full": frozenset({"pipeline", "browser", "collection", "scoring", "greeting", "delivery", "monitor"}),
    "collect": frozenset({"browser", "collection"}),
    "score": frozenset({"scoring"}),
    "rescore": frozenset({"scoring"}),
    "greet": frozenset({"greeting"}),
    "monitor": frozenset({"browser", "monitor"}),
    # A normal delivery includes greeting generation; direct_send explicitly
    # opts out of that AI stage and therefore only needs the browser lane.
    "deliver": frozenset({"browser", "delivery", "greeting"}),
}


class TaskAlreadyRunningError(RuntimeError):
    """Raised when a workbench task needs a resource lane already in use."""


@dataclass
class WorkbenchTask:
    id: str
    mode: str
    label: str
    status: str = "running"
    logs: list[str] = field(default_factory=list)
    error: str | None = None
    created_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    deadline_at: str | None = None
    stop_reason: str | None = None
    stop_requested: Event = field(default_factory=Event, repr=False)
    pause_requested: Event = field(default_factory=Event, repr=False)
    metrics: dict[str, int] = field(default_factory=dict)
    progress: dict[str, Any] = field(default_factory=dict)
    greeting_progress: dict[str, Any] = field(default_factory=dict)
    scoring_progress: dict[str, Any] = field(default_factory=dict)
    send_progress: dict[str, Any] = field(default_factory=dict)
    # Lightweight identity of the job currently being generated or delivered.
    # Keeping this separate from numeric metrics lets the dashboard show a
    # useful label without exposing the full JD or resume.
    current_job: dict[str, str] | None = None
    resources: tuple[str, ...] = field(default_factory=tuple)
    context: dict[str, Any] = field(default_factory=dict, repr=False)

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "mode": self.mode,
            "label": self.label,
            "status": self.status,
            "logs": list(self.logs),
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "deadline_at": self.deadline_at,
            "stop_reason": self.stop_reason,
            "stop_requested": self.stop_requested.is_set(),
            "pause_requested": self.pause_requested.is_set(),
            "can_resume": self.status == "paused",
            "metrics": dict(self.metrics),
            "progress": dict(self.progress),
            "greeting_progress": dict(self.greeting_progress),
            "scoring_progress": dict(self.scoring_progress),
            "send_progress": dict(self.send_progress),
            "current_job": dict(self.current_job) if self.current_job else None,
            "resources": list(self.resources),
            "checkpoint": dict(self.context.get("checkpoint", {})),
        }


Executor = Callable[[WorkbenchTask, dict], None]


def wait_for_initial_monitor_cooldown(
    task: WorkbenchTask,
    config: dict,
    log: Callable[[WorkbenchTask, str], None],
) -> bool:
    """Wait for the full-flow monitor cooldown; return true when cancellation wins."""
    raw_cooldown = config.get("monitor", {}).get("initial_cooldown_minutes", 10)
    try:
        cooldown_sec = max(float(raw_cooldown), 0) * 60
    except (TypeError, ValueError):
        cooldown_sec = 10 * 60
    if cooldown_sec <= 0:
        return False
    log(task, f"发送结束，首次监测将在 {cooldown_sec / 60:g} 分钟冷却后开始")
    if task.stop_requested.wait(cooldown_sec):
        log(task, "首次监测冷却已取消")
        return True
    return False


class WorkbenchTaskRunner:
    def __init__(self, executors: dict[str, Executor] | None = None):
        self._executors = executors or {}
        self._tasks: dict[str, WorkbenchTask] = {}
        self._threads: dict[str, Thread] = {}
        self._deadline_timers: dict[str, Timer] = {}
        self._lock = Lock()

    def start(self, mode: str, config: dict) -> dict:
        if mode not in MODE_LABELS:
            raise ValueError(f"Unsupported workbench mode: {mode}")

        with self._lock:
            resources = _resources_for_mode(mode, config)
            conflicts = self._conflicting_tasks_locked(resources)
            if conflicts:
                labels = "、".join(f"「{task.label}」" for task in conflicts[:3])
                raise TaskAlreadyRunningError(
                    f"当前任务与后台任务{labels}存在资源冲突，请等待其完全结束"
                )

            task = WorkbenchTask(
                id=str(uuid4()),
                mode=mode,
                label=MODE_LABELS[mode],
                resources=tuple(sorted(resources)),
            )
            # Keep the task-start configuration available for a later resume.
            # Runtime-only hooks/events are replaced by the executor on each run.
            task.context["resume_config"] = dict(config)
            deadline = _deadline_from_config(mode, config)
            if deadline:
                task.deadline_at = deadline.isoformat(timespec="seconds")
            self._tasks[task.id] = task

            if deadline and deadline <= datetime.now():
                task.stop_requested.set()
                task.status = "stopped"
                task.stop_reason = "今日发送时间窗口已截止，后台未启动"
                task.logs.append(task.stop_reason)
                task.updated_at = datetime.now().isoformat(timespec="seconds")
                return task.snapshot()

            thread = Thread(target=self._run, args=(task, config), daemon=True)
            self._threads[task.id] = thread
            if deadline:
                delay_seconds = max((deadline - datetime.now()).total_seconds(), 0)
                timer = Timer(delay_seconds, self._stop_at_deadline, args=(task.id,))
                timer.daemon = True
                self._deadline_timers[task.id] = timer
                timer.start()
            thread.start()
            return task.snapshot()

    def status(self) -> dict:
        with self._lock:
            active_tasks = self._active_tasks_locked()
            tasks = [task.snapshot() for task in self._tasks.values()]
            return {
                # ``active`` is retained for older clients; new clients should
                # consume ``active_tasks`` so simultaneous independent tasks
                # are visible instead of being silently hidden.
                "active": active_tasks[0].snapshot() if active_tasks else None,
                "active_tasks": [task.snapshot() for task in active_tasks],
                "last_task": tasks[-1] if tasks else None,
                "tasks": tasks,
            }

    def conflicts(self, mode: str, config: dict | None = None) -> list[dict]:
        """Return active tasks that would block a prospective task.

        This read-only helper lets API routes validate before mutating job
        state (for example before marking a job approved for delivery).
        """
        resources = _resources_for_mode(mode, config)
        with self._lock:
            return [task.snapshot() for task in self._conflicting_tasks_locked(resources)]

    def stop(self, task_id: str, reason: str = "用户已请求停止") -> dict:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                raise KeyError(task_id)
            if task.status in TERMINAL_STATUSES:
                return task.snapshot()
            if task.status == "paused":
                task.pause_requested.clear()
                task.stop_requested.set()
                task.status = "stopped"
                task.stop_reason = reason
                if reason and (not task.logs or task.logs[-1] != reason):
                    task.logs.append(reason)
                task.updated_at = datetime.now().isoformat(timespec="seconds")
                return task.snapshot()
            task.pause_requested.clear()
            task.stop_requested.set()
            task.status = "stopping"
            task.stop_reason = reason
            if reason and (not task.logs or task.logs[-1] != reason):
                task.logs.append(reason)
            task.updated_at = datetime.now().isoformat(timespec="seconds")
            confirmation_event = task.context.get("confirmation_event")
            if isinstance(confirmation_event, Event):
                confirmation_event.set()
            monitor_wakeup_event = task.context.get("monitor_wakeup_event")
            if isinstance(monitor_wakeup_event, Event):
                monitor_wakeup_event.set()
            return task.snapshot()

    def pause(self, task_id: str, reason: str = "用户已请求暂停") -> dict:
        """Cooperatively stop at the next safe checkpoint and retain the task."""
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                raise KeyError(task_id)
            if task.status == "paused":
                return task.snapshot()
            if task.status in TERMINAL_STATUSES:
                return task.snapshot()
            task.pause_requested.set()
            task.stop_requested.set()
            task.status = "pausing"
            task.stop_reason = reason
            if reason and (not task.logs or task.logs[-1] != reason):
                task.logs.append(reason)
            task.updated_at = datetime.now().isoformat(timespec="seconds")
            self._wake_task(task)
            return task.snapshot()

    def resume(self, task_id: str, config: dict | None = None) -> dict:
        """Restart a paused task using its checkpoint and latest safe settings."""
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                raise KeyError(task_id)
            if task.status != "paused":
                raise ValueError("只有已暂停的任务可以继续")
            runtime_config = config if isinstance(config, dict) else task.context.get("resume_config", {})
            resources = _resources_for_mode(task.mode, runtime_config)
            conflicts = self._conflicting_tasks_locked(resources, exclude=task)
            if conflicts:
                labels = "、".join(f"「{item.label}」" for item in conflicts[:3])
                raise TaskAlreadyRunningError(
                    f"当前任务与后台任务{labels}存在资源冲突，请等待其完全结束"
                )
            task.context["resume_config"] = dict(runtime_config)
            task.resources = tuple(sorted(resources))
            task.context["resume_requested"] = True
            task.pause_requested.clear()
            task.stop_requested.clear()
            task.stop_reason = None
            task.error = None
            task.status = "running"
            task.updated_at = datetime.now().isoformat(timespec="seconds")
            thread = Thread(target=self._run, args=(task, runtime_config), daemon=True)
            self._threads[task.id] = thread
            thread.start()
            return task.snapshot()

    def retry(self, task_id: str, config: dict | None = None) -> dict:
        """Retry a failed/stopped task using its original checkpoint/config."""
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                raise KeyError(task_id)
            if task.status not in {"failed", "stopped"}:
                raise ValueError("只有失败或已停止的任务可以重试")
            runtime_config = config if isinstance(config, dict) else task.context.get("resume_config", {})
            resources = _resources_for_mode(task.mode, runtime_config)
            conflicts = self._conflicting_tasks_locked(resources, exclude=task)
            if conflicts:
                labels = "、".join(f"「{item.label}」" for item in conflicts[:3])
                raise TaskAlreadyRunningError(f"当前任务与后台任务{labels}存在资源冲突，请等待其完全结束")
            task.context["resume_config"] = dict(runtime_config)
            task.context["resume_requested"] = bool(task.context.get("checkpoint"))
            task.stop_requested.clear()
            task.pause_requested.clear()
            task.stop_reason = None
            task.error = None
            task.status = "running"
            task.updated_at = datetime.now().isoformat(timespec="seconds")
            thread = Thread(target=self._run, args=(task, runtime_config), daemon=True)
            self._threads[task.id] = thread
            thread.start()
            return task.snapshot()

    def wait(self, timeout: float | None = None) -> None:
        threads = list(self._threads.values())
        for thread in threads:
            thread.join(timeout=timeout)

    def _run(self, task: WorkbenchTask, config: dict) -> None:
        try:
            executor = self._executors.get(task.mode)
            if executor:
                executor(task, config)
            with self._lock:
                if task.pause_requested.is_set():
                    task.status = "paused"
                    task.stop_reason = task.stop_reason or "任务已暂停，可从断点继续"
                elif task.stop_requested.is_set():
                    task.status = "stopped"
                else:
                    task.status = "completed"
                task.updated_at = datetime.now().isoformat(timespec="seconds")
        except Exception as exc:
            with self._lock:
                if task.pause_requested.is_set():
                    task.status = "paused"
                    task.error = None
                    task.stop_reason = task.stop_reason or "任务已暂停，可从断点继续"
                elif task.stop_requested.is_set():
                    task.status = "stopped"
                    task.error = None
                else:
                    task.status = "failed"
                    task.error = str(exc)
                task.updated_at = datetime.now().isoformat(timespec="seconds")
        finally:
            with self._lock:
                timer = self._deadline_timers.pop(task.id, None)
            if timer:
                timer.cancel()

    def _stop_at_deadline(self, task_id: str) -> None:
        try:
            self.stop(task_id, "已到发送时间窗口截止时间，后台自动停止")
        except KeyError:
            return

    def _active_task_locked(self) -> WorkbenchTask | None:
        active = self._active_tasks_locked()
        return active[0] if active else None

    def _active_tasks_locked(self) -> list[WorkbenchTask]:
        return [task for task in self._tasks.values() if task.status in ACTIVE_STATUSES]

    def _conflicting_tasks_locked(
        self,
        resources: frozenset[str],
        *,
        exclude: WorkbenchTask | None = None,
    ) -> list[WorkbenchTask]:
        conflicts: list[WorkbenchTask] = []
        for task in self._active_tasks_locked():
            if task is exclude:
                continue
            task_resources = frozenset(task.resources or _resources_for_mode(task.mode, task.context.get("resume_config", {})))
            if "pipeline" in resources or "pipeline" in task_resources or resources & task_resources:
                conflicts.append(task)
        return conflicts

    @staticmethod
    def _wake_task(task: WorkbenchTask) -> None:
        for key in ("confirmation_event", "monitor_wakeup_event"):
            event = task.context.get(key)
            if isinstance(event, Event):
                event.set()


def _deadline_from_config(mode: str, config: dict) -> datetime | None:
    """Resolve the automatic stop deadline for long-running/send tasks."""
    if mode not in DEADLINE_MODES:
        return None
    throttle = config.get("throttle", {}) if isinstance(config, dict) else {}
    windows = throttle.get("send_windows", [])
    if not isinstance(windows, list):
        return None
    return SendWindowChecker(windows).latest_end_datetime()


def _resources_for_mode(mode: str, config: dict | None = None) -> frozenset[str]:
    """Resolve the resource lanes a task occupies.

    Delivery can skip greeting generation when the caller supplies
    ``_workbench_skip_greeting``.  Collection with ``auto_score`` owns the
    scoring lane as well, preventing two workers from selecting and updating
    the same scoring batch concurrently.
    """
    resources = set(MODE_RESOURCES.get(mode, frozenset()))
    config = config if isinstance(config, dict) else {}
    if mode == "collect":
        options = config.get("_collection_options")
        collection_cfg = config.get("collection") if isinstance(config.get("collection"), dict) else {}
        if (isinstance(options, dict) and options.get("auto_score") is True) or collection_cfg.get("auto_score") is True:
            resources.add("scoring")
    elif mode == "deliver" and config.get("_workbench_skip_greeting"):
        resources.discard("greeting")
    return frozenset(resources)
