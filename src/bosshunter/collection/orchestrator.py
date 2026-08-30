"""Shared filtering, persistence and controlled multi-platform collection execution."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from pathlib import Path
from queue import Empty, Queue
from threading import Event, RLock, Thread
from typing import Any, Callable
from uuid import uuid4

from bosshunter.browser import click, close_tab, evaluate, navigate, new_tab, press_key, scroll, type_text, wait_for_load
from bosshunter.collection.base import CollectionError, CollectorHooks
from bosshunter.collection.models import (
    CollectionProgress,
    JobCandidate,
    PlatformCollectionRequest,
    PlatformCollectionResult,
)
from bosshunter.collection.platforms.boss import BossCollector
from bosshunter.collection.platforms.job51 import Job51Browser, Job51Collector, get_51job_city_code
from bosshunter.collection.platforms.zhilian import ZhilianBrowser, ZhilianCollector, get_zhilian_city_code
from bosshunter.collection.registry import CollectorRegistry
from bosshunter.collection_run_store import create_collection_run, get_collection_run, update_collection_run
from bosshunter.db import get_db, insert_job_if_new, job_identity_exists
from bosshunter.job_filters import matches_search_keyword, matching_blocked_company, matching_deal_breaker


SUPPORTED_PLATFORMS = {"boss", "zhilian", "51job"}
SORT_OPTIONS = {
    "boss": {"default", "newest"},
    "zhilian": {"default", "newest"},
    "51job": {"default"},
}
EXECUTION_MODES = {"safe_serial", "pipelined", "parallel_pilot"}


class _StopSignal:
    """Expose an Event-like view that can also cancel a parallel stage internally."""

    def __init__(self, external: Event | None):
        self.external = external
        self.internal = Event()

    def is_set(self) -> bool:
        return self.internal.is_set() or bool(self.external and self.external.is_set())

    def set(self) -> None:
        self.internal.set()

    def wait(self, timeout: float | None = None) -> bool:
        if self.is_set():
            return True
        if timeout is None:
            while not self.is_set():
                self.internal.wait(0.1)
            return True
        remaining = max(float(timeout), 0.0)
        while remaining > 0:
            step = min(remaining, 0.1)
            if self.internal.wait(step) or self.is_set():
                return True
            remaining -= step
        return self.is_set()


class _BrowserTargetBudget:
    """Bound background tabs owned by the non-BOSS parallel pilot."""

    def __init__(self, limit: int, stop_event: _StopSignal):
        self.limit = max(1, min(int(limit), 3))
        self.stop_event = stop_event
        self._available = self.limit
        self._targets: set[str] = set()
        self._lock = RLock()

    def open(self, url: str, background: bool = False) -> str | None:
        while True:
            with self._lock:
                if self._available > 0:
                    self._available -= 1
                    break
            if self.stop_event.wait(0.1):
                return None
        target = new_tab(url, background=background)
        with self._lock:
            if target:
                self._targets.add(str(target))
                return str(target)
            self._available += 1
        return None

    def close(self, target_id: str) -> bool:
        try:
            return close_tab(target_id)
        finally:
            with self._lock:
                if str(target_id) in self._targets:
                    self._targets.remove(str(target_id))
                    self._available = min(self.limit, self._available + 1)

    def active_count(self) -> int:
        with self._lock:
            return len(self._targets)

    def close_remaining(self) -> None:
        with self._lock:
            targets = list(self._targets)
        for target in targets:
            self.close(target)


class _ScoringPipeline:
    """Score committed batches while the next collection stage is running."""

    def __init__(self, config: dict[str, Any], stop_event: _StopSignal, on_progress: Callable[[], None]):
        self.config = config
        self.stop_event = stop_event
        self.on_progress = on_progress
        self.batch_size = max(1, min(int(config.get("collection", {}).get("score_batch_size", 5) or 5), 20))
        self.flush_seconds = max(0.1, min(float(config.get("collection", {}).get("score_flush_ms", 1000) or 1000) / 1000, 5.0))
        self._queue: Queue[list[str] | None] = Queue()
        self._thread: Thread | None = None
        self._seen: set[str] = set()
        self.errors: list[str] = []

    def submit(self, job_ids: list[str]) -> None:
        values = [str(job_id) for job_id in job_ids if str(job_id) and str(job_id) not in self._seen]
        self._seen.update(values)
        if not values or self.stop_event.is_set():
            return
        if self._thread is None:
            self._thread = Thread(target=self._run, name="bosshunter-collection-score", daemon=True)
            self._thread.start()
        self._queue.put(values)

    def close(self) -> None:
        if self._thread is None:
            return
        self._queue.put(None)
        self._thread.join()

    def _run(self) -> None:
        pending: list[str] = []
        while not self.stop_event.is_set():
            try:
                item = self._queue.get(timeout=self.flush_seconds)
            except Empty:
                item = []
            if item is None:
                if pending:
                    self._score(pending)
                return
            pending.extend(item)
            if len(pending) >= self.batch_size:
                self._score(pending[:self.batch_size])
                pending = pending[self.batch_size:]
        # Do not start a fresh AI request after a user or risk cancellation.

    def _score(self, job_ids: list[str]) -> None:
        if not job_ids or self.stop_event.is_set():
            return
        try:
            from bosshunter.ai.scorer import score_jobs

            score_config = dict(self.config)
            score_config["_workbench_stop_event"] = self.stop_event
            score_config["_workbench_score_progress"] = lambda _state: self.on_progress()
            score_jobs(score_config, scope="selected", job_ids=job_ids, limit=None, force_rescore=False)
        except Exception as exc:
            self.errors.append(f"自动评分失败：{type(exc).__name__}: {str(exc)[:240]}")


def _clean_strings(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    result: list[str] = []
    for value in values:
        cleaned = str(value or "").strip()
        if cleaned and cleaned not in result:
            result.append(cleaned)
    return result


def normalize_collection_options(config: dict[str, Any], raw_options: dict[str, Any] | None = None) -> dict[str, Any]:
    """Build a validated collection request while keeping legacy BOSS config compatible."""
    supplied = deepcopy(raw_options) if isinstance(raw_options, dict) else {}
    raw_platforms = supplied.get("platforms") if isinstance(supplied.get("platforms"), dict) else {}
    configured_platforms = config.get("platforms") if isinstance(config.get("platforms"), dict) else {}
    legacy_search = config.get("search") if isinstance(config.get("search"), dict) else {}
    boss_search = configured_platforms.get("boss", {}).get("search", {}) if isinstance(configured_platforms.get("boss"), dict) else {}
    if not boss_search:
        boss_search = legacy_search
    elif isinstance(legacy_search, dict):
        # ``load_config`` supplies platform defaults even for old config.yaml
        # files. Non-empty legacy search values must still win over those empty
        # defaults, while explicit platform values remain authoritative.
        boss_search = dict(boss_search)
        for key, value in legacy_search.items():
            if value not in (None, "", [], {}):
                if boss_search.get(key) in (None, "", [], {}):
                    boss_search[key] = value
    if (
        isinstance(legacy_search, dict)
        and not raw_platforms.get("boss")
        and not (boss_search.get("keywords") or boss_search.get("cities"))
        and (legacy_search.get("keywords") or legacy_search.get("cities"))
    ):
        boss_search = dict(legacy_search)
    zhilian_search = configured_platforms.get("zhilian", {}).get("search", {}) if isinstance(configured_platforms.get("zhilian"), dict) else {}
    job51_search = configured_platforms.get("51job", {}).get("search", {}) if isinstance(configured_platforms.get("51job"), dict) else {}

    platforms: dict[str, Any] = {}
    for platform, fallback in (("boss", boss_search), ("zhilian", zhilian_search), ("51job", job51_search)):
        value = raw_platforms.get(platform) if isinstance(raw_platforms.get(platform), dict) else {}
        search = value.get("search") if isinstance(value.get("search"), dict) else value
        if not isinstance(search, dict):
            search = {}
        base = dict(fallback) if isinstance(fallback, dict) else {}
        base.update(search)
        if platform == "boss" and not base.get("cities"):
            base["cities"] = config.get("profile", {}).get("target_cities", ["北京"])
        platforms[platform] = {
            "keywords": _clean_strings(base.get("keywords")),
            "cities": _clean_strings(base.get("cities")),
            "city_codes": {
                str(key).strip(): str(value).strip()
                for key, value in (base.get("city_codes") or {}).items()
                if str(key).strip() and str(value).strip()
            } if isinstance(base.get("city_codes"), dict) else {},
            "max_pages": base.get("max_pages", 3 if platform == "boss" else 1),
            "sort": str(base.get("sort") or ("newest" if platform == "boss" else "default")),
        }

    order = supplied.get("platform_order")
    if order is None:
        configured_order = config.get("collection", {}).get("default_order") if isinstance(config.get("collection"), dict) else None
        order = configured_order if isinstance(configured_order, list) else ["boss"]
        if not supplied:
            enabled_platforms = {"boss"}
            for platform, value in configured_platforms.items():
                if isinstance(value, dict) and value.get("enabled"):
                    enabled_platforms.add(str(platform))
            order = [platform for platform in order if platform in enabled_platforms]
            if not order:
                order = ["boss"]
    order = [str(value).strip() for value in order if str(value).strip()] if isinstance(order, list) else []
    selected_platforms = supplied.get("platforms") if isinstance(supplied.get("platforms"), dict) else None
    if supplied and selected_platforms is not None:
        selected = {str(key).strip() for key in selected_platforms if str(key).strip()}
        order = [platform for platform in order if platform in selected]
    collection_config = config.get("collection", {}) if isinstance(config.get("collection"), dict) else {}
    requested_mode = supplied.get("execution_mode", collection_config.get("execution_mode", "safe_serial"))
    options = {
        "platform_order": order,
        "auto_score": supplied.get("auto_score", False) is True,
        "execution_mode": str(requested_mode or "safe_serial").strip(),
        "platforms": {platform: platforms[platform] for platform in order if platform in platforms},
    }
    return validate_collection_options(options)


def validate_collection_options(options: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(options, dict):
        raise ValueError("采集参数必须是对象")
    order = options.get("platform_order")
    platforms = options.get("platforms")
    if not isinstance(order, list) or not order:
        raise ValueError("至少选择一个采集平台")
    order = [str(value).strip() for value in order]
    if len(order) != len(set(order)):
        raise ValueError("采集平台顺序不能重复")
    if any(platform not in SUPPORTED_PLATFORMS for platform in order):
        raise ValueError("采集平台只支持 boss、zhilian 或 51job")
    if not isinstance(platforms, dict) or set(platforms) != set(order):
        raise ValueError("平台顺序与平台配置不一致")
    if not isinstance(options.get("auto_score", False), bool):
        raise ValueError("auto_score 必须是布尔值")
    execution_mode = str(options.get("execution_mode") or "safe_serial").strip()
    if execution_mode not in EXECUTION_MODES:
        raise ValueError("采集速度模式只支持 safe_serial、pipelined 或 parallel_pilot")
    normalized: dict[str, Any] = {
        "platform_order": order,
        "auto_score": bool(options.get("auto_score")),
        "execution_mode": execution_mode,
        "platforms": {},
    }
    for platform in order:
        value = platforms.get(platform)
        if not isinstance(value, dict):
            raise ValueError(f"{platform} 平台配置无效")
        keywords = _clean_strings(value.get("keywords"))
        cities = _clean_strings(value.get("cities"))
        if not keywords:
            raise ValueError(f"{platform} 至少需要一个非空关键词")
        if not cities:
            raise ValueError(f"{platform} 至少需要一个城市")
        city_codes = value.get("city_codes") if isinstance(value.get("city_codes"), dict) else {}
        city_codes = {str(key).strip(): str(code).strip() for key, code in city_codes.items() if str(key).strip()}
        if platform == "zhilian":
            for city in cities:
                resolved = get_zhilian_city_code(city)
                if resolved:
                    # The platform snapshot is authoritative for known cities;
                    # this prevents a legacy BOSS code from crossing platforms.
                    city_codes[city] = resolved
            missing_cities = [city for city in cities if not city_codes.get(city)]
            if missing_cities:
                names = "、".join(missing_cities)
                raise ValueError(f"智联暂未内置城市编码：{names}；请换用采集窗口提供的城市名称，不能填写 BOSS 编码")
        if platform == "51job":
            for city in cities:
                resolved = get_51job_city_code(city)
                if resolved:
                    city_codes[city] = resolved
            missing_cities = [city for city in cities if not city_codes.get(city)]
            if missing_cities:
                names = "、".join(missing_cities)
                raise ValueError(f"51job 当前只开放已验证城市：{names} 尚未支持；不会猜测城市编码")
        try:
            max_pages = int(value.get("max_pages", 3))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{platform} 最大页数必须是整数") from exc
        if not 1 <= max_pages <= 10:
            raise ValueError(f"{platform} 最大页数范围为 1-10")
        sort = str(value.get("sort") or "default").strip()
        if sort not in SORT_OPTIONS[platform]:
            raise ValueError(f"{platform} 排序方式无效")
        normalized["platforms"][platform] = {
            "keywords": keywords,
            "cities": cities,
            "city_codes": city_codes,
            "max_pages": max_pages,
            "sort": sort,
        }
    return normalized


class _SharedProcessor:
    def __init__(
        self,
        conn,
        request: PlatformCollectionRequest,
        *,
        run_id: str,
        platform_index: int,
        platform_total: int,
        stop_event: Event | None,
        config: dict[str, Any],
        emit: Callable[[CollectionProgress], None],
        db_lock: RLock | None = None,
    ):
        self.conn = conn
        self.request = request
        self.run_id = run_id
        self.platform_index = platform_index
        self.platform_total = platform_total
        self.stop_event = stop_event
        self.config = config
        self.emit = emit
        self.db_lock = db_lock
        self.progress = CollectionProgress(
            run_id=run_id, platform=request.platform, platform_index=platform_index,
            platform_total=platform_total, phase="queued", target=None,
            max_pages=request.max_pages,
        )
        self.new_job_ids: list[str] = []

    def event(self, *, phase: str | None = None, **values: Any) -> None:
        if phase:
            self.progress.phase = phase
        if values.pop("increment_filtered", False):
            self.progress.filtered += 1
        for key, value in values.items():
            if hasattr(self.progress, key):
                setattr(self.progress, key, value)
        self.emit(self.progress)

    def inspect(self, candidate: JobCandidate) -> bool:
        self.progress.seen += 1
        if self.db_lock is not None:
            with self.db_lock:
                exists = job_identity_exists(
                    self.conn, candidate.platform, candidate.source_job_id, legacy_job_id=candidate.storage_id,
                )
        else:
            exists = job_identity_exists(
                self.conn, candidate.platform, candidate.source_job_id, legacy_job_id=candidate.storage_id,
            )
        if exists:
            self.progress.duplicate += 1
            self.event()
            return False
        profile = self.config.get("profile", {}) if isinstance(self.config.get("profile"), dict) else {}
        if matching_deal_breaker(candidate.title, profile.get("deal_breakers") or []):
            self.progress.filtered += 1
            self.event(message="职位名命中过滤规则")
            return False
        if matching_blocked_company(candidate.company, profile.get("blocked_companies") or []):
            self.progress.filtered += 1
            self.event(message="公司命中过滤规则")
            return False
        self.event()
        return True

    def save(self, candidate: JobCandidate) -> bool:
        profile = self.config.get("profile", {}) if isinstance(self.config.get("profile"), dict) else {}
        if not matches_search_keyword(candidate.title, candidate.jd, candidate.source_keyword):
            self.progress.filtered += 1
            self.event(message=f"搜索关键词未命中: {candidate.source_keyword}")
            return True
        if matching_deal_breaker(candidate.jd, profile.get("jd_deal_breakers") or []):
            self.progress.filtered += 1
            self.event(message="JD 命中过滤规则")
            return True
        try:
            if self.db_lock is not None:
                with self.db_lock:
                    inserted = insert_job_if_new(self.conn, candidate.as_job_record())
            else:
                inserted = insert_job_if_new(self.conn, candidate.as_job_record())
        except Exception as exc:
            self.progress.save_failed += 1
            self.event(message=f"保存岗位失败：{type(exc).__name__}")
            return True
        if inserted:
            self.new_job_ids.append(candidate.storage_id)
        else:
            self.progress.duplicate += 1
        self.event(phase="saving")
        if self.stop_event is not None and self.stop_event.is_set():
            return False
        return self.stop_event is None or not self.stop_event.is_set()


class CollectionOrchestrator:
    """Run selected platform collectors one after another in the given order."""

    def __init__(
        self,
        config: dict[str, Any],
        *,
        db_path: Path | None = None,
        registry: CollectorRegistry | None = None,
        run_id: str | None = None,
        task_id: str = "",
    ):
        self.config = config
        self.db_path = db_path or Path("./data/bosshunter.db")
        self._uses_default_registry = registry is None
        self.registry = registry or CollectorRegistry({
            "boss": BossCollector,
            "zhilian": ZhilianCollector,
            "51job": Job51Collector,
        })
        self.run_id = run_id or str(uuid4())
        self.task_id = task_id
        self.stop_event = config.get("_workbench_stop_event")
        self.pause_event = config.get("_workbench_pause_event")
        self._state_lock = RLock()
        self._db_lock = RLock()

    def run(self, raw_options: dict[str, Any] | None = None) -> dict[str, Any]:
        options = normalize_collection_options(self.config, raw_options)
        requested_mode = options["execution_mode"]
        effective_mode, degradation_reason = self._effective_execution_mode(options)
        options["requested_execution_mode"] = requested_mode
        options["execution_mode"] = effective_mode
        if effective_mode == "safe_serial":
            result = self._run_serial(options)
        else:
            result = self._run_accelerated(options)
        if degradation_reason:
            result["execution"] = {
                "requested_mode": requested_mode,
                "effective_mode": effective_mode,
                "degraded": True,
                "degradation_reason": degradation_reason,
            }
        return result

    def _run_serial(self, options: dict[str, Any]) -> dict[str, Any]:
        order = options["platform_order"]
        states: dict[str, dict[str, Any]] = {
            platform: {"status": "queued", "new": 0, "target": None, "percent": None}
            for platform in order
        }
        resume_run_id = str(self.config.get("_workbench_resume_run_id") or "")
        previous = get_collection_run(self.db_path, resume_run_id) if resume_run_id else None
        start_index = 0
        all_new_ids: list[str] = []
        if previous and previous.get("status") == "paused":
            self.run_id = resume_run_id
            saved_states = previous.get("platform_states")
            if isinstance(saved_states, dict):
                for platform in order:
                    if isinstance(saved_states.get(platform), dict):
                        states[platform].update(saved_states[platform])
            all_new_ids = [str(job_id) for job_id in previous.get("collected_job_ids", []) if str(job_id)]
            current_platform = str(previous.get("current_platform") or "")
            if current_platform in order:
                start_index = order.index(current_platform)
        else:
            create_collection_run(self.db_path, run_id=self.run_id, task_id=self.task_id, options=options, platform_states=states)
        platform_results: list[PlatformCollectionResult] = []
        current_platform = ""
        conn = get_db(self.db_path)
        try:
            for index, platform in enumerate(order[start_index:], start=start_index + 1):
                current_platform = platform
                if self.stop_event is not None and self.stop_event.is_set():
                    states[platform]["status"] = "stopped"
                    states[platform]["reason_code"] = "user_stopped"
                    break
                raw = options["platforms"][platform]
                request = PlatformCollectionRequest(platform=platform, **raw)
                states[platform]["status"] = "running"
                self._persist(states, all_new_ids, platform)
                processor = _SharedProcessor(
                    conn, request, run_id=self.run_id, platform_index=index, platform_total=len(order),
                    stop_event=self.stop_event, config=self.config,
                    emit=lambda progress, p=platform, processor_ref=None: self._emit(
                        states, p, progress, all_new_ids, processor_ref.new_job_ids if processor_ref else []
                    ),
                )
                # Bind the processor into the callback after construction so the
                # current platform's progress is not confused with prior IDs.
                processor.emit = lambda progress, p=platform, processor_ref=processor: self._emit(
                    states, p, progress, all_new_ids, processor_ref.new_job_ids
                )
                hooks = CollectorHooks(
                    stop_event=self.stop_event,
                    on_list_candidate=processor.inspect,
                    on_candidate=processor.save,
                    on_parse_failed=lambda reason, p=processor: self._parse_failed(p, reason),
                    on_event=lambda p=processor, **kwargs: p.event(**kwargs),
                )
                try:
                    collector = (
                        BossCollector(config=self.config, safety_conn=conn)
                        if platform == "boss" and self._uses_default_registry
                        else self.registry.get(platform)
                    )
                    result = collector.collect(request, hooks)
                except CollectionError as exc:
                    result = PlatformCollectionResult(platform, "blocked", exc.code, exc.message, error=str(exc))
                except Exception as exc:
                    result = PlatformCollectionResult(platform, "failed", "network_error", f"{platform} 采集失败", error=str(exc)[:500])
                result.new_job_ids = list(processor.new_job_ids)
                result.counts = self._counts(processor.progress)
                platform_results.append(result)
                states[platform].update({
                    "status": result.status,
                    "new": len(result.new_job_ids),
                    "percent": processor.progress.percent,
                    "seen": processor.progress.seen,
                    "duplicate": processor.progress.duplicate,
                    "filtered": processor.progress.filtered,
                    "parse_failed": processor.progress.parse_failed,
                    "save_failed": processor.progress.save_failed,
                    "keyword": processor.progress.keyword,
                    "city": processor.progress.city,
                    "page": processor.progress.page,
                    "max_pages": processor.progress.max_pages,
                    "reason_code": result.reason_code,
                    "message": result.message,
                })
                all_new_ids.extend(result.new_job_ids)
                self._persist(states, all_new_ids, platform, stop_reason=result.reason_code, error=result.error)
                # A verification, rate-limit, or unknown blocking page is an
                # account-level signal. Stop the entire serial queue instead
                # of immediately moving the same browser session to another
                # recruitment platform.
                if (
                    result.status == "blocked"
                    or result.reason_code in {"user_stopped", "browser_disconnected"}
                    or (self.stop_event and self.stop_event.is_set())
                ):
                    break

        finally:
            conn.close()

        unique_new_ids = list(dict.fromkeys(str(job_id) for job_id in all_new_ids if str(job_id)))
        paused = bool(self.pause_event and self.pause_event.is_set())
        stopped = bool(self.stop_event and self.stop_event.is_set()) or any(r.reason_code == "user_stopped" for r in platform_results)
        errors = any(r.status in {"blocked", "failed"} for r in platform_results)
        shortages = any(r.status == "completed_with_shortage" for r in platform_results)
        outcome = "paused" if paused else "stopped" if stopped else "completed_with_errors" if errors else "completed_with_shortage" if shortages else "completed"
        if options["auto_score"] and unique_new_ids and not stopped:
            try:
                self._emit_scoring(states, unique_new_ids)
                from bosshunter.ai.scorer import score_jobs

                score_config = dict(self.config)
                score_config["_workbench_stop_event"] = self.stop_event
                score_jobs(score_config, scope="selected", job_ids=unique_new_ids, limit=None, force_rescore=False)
            except Exception as exc:
                outcome = "completed_with_errors"
                self._persist(states, unique_new_ids, "", error=f"自动评分失败：{str(exc)[:500]}")
        self._persist(
            states,
            unique_new_ids,
            current_platform if paused else "",
            status=outcome,
            stop_reason="用户暂停，可从当前平台继续" if paused else "user_stopped" if stopped else "",
        )
        return {
            "run_id": self.run_id,
            "status": outcome,
            "platforms": states,
            "collected_job_ids": unique_new_ids,
            "results": [result.__dict__ for result in platform_results],
        }

    def _effective_execution_mode(self, options: dict[str, Any]) -> tuple[str, str]:
        requested = str(options.get("execution_mode") or "safe_serial")
        if requested != "parallel_pilot":
            return requested, ""
        collection_cfg = self.config.get("collection", {}) if isinstance(self.config.get("collection"), dict) else {}
        selected = set(options.get("platform_order") or [])
        if collection_cfg.get("parallel_pilot_enabled") is not True:
            return ("pipelined" if options.get("auto_score") else "safe_serial"), "并行试点尚未开放，已使用安全模式"
        if not {"zhilian", "51job"} <= selected:
            return ("pipelined" if options.get("auto_score") else "safe_serial"), "并行试点需要同时选择智联和 51job"
        return "parallel_pilot", ""

    @staticmethod
    def _stage_plan(order: list[str], mode: str) -> list[list[str]]:
        if mode != "parallel_pilot":
            return [[platform] for platform in order]
        stages: list[list[str]] = []
        pending_non_boss: list[str] = []
        for platform in order:
            if platform == "boss":
                if pending_non_boss:
                    stages.append(pending_non_boss)
                    pending_non_boss = []
                stages.append([platform])
            else:
                pending_non_boss.append(platform)
        if pending_non_boss:
            stages.append(pending_non_boss)
        return stages

    def _run_accelerated(self, options: dict[str, Any]) -> dict[str, Any]:
        """Run serial stages or the bounded non-BOSS parallel pilot.

        Each platform receives its own SQLite connection. ``_db_lock`` keeps
        writes deterministic while the database's unique source identity index
        remains the final deduplication authority.
        """
        order = options["platform_order"]
        states: dict[str, dict[str, Any]] = {
            platform: {"status": "queued", "new": 0, "target": None, "percent": None}
            for platform in order
        }
        resume_run_id = str(self.config.get("_workbench_resume_run_id") or "")
        previous = get_collection_run(self.db_path, resume_run_id) if resume_run_id else None
        start_index = 0
        all_new_ids: list[str] = []
        if previous and previous.get("status") == "paused":
            self.run_id = resume_run_id
            saved_states = previous.get("platform_states")
            if isinstance(saved_states, dict):
                for platform in order:
                    if isinstance(saved_states.get(platform), dict):
                        states[platform].update(saved_states[platform])
            all_new_ids = [str(job_id) for job_id in previous.get("collected_job_ids", []) if str(job_id)]
            current_platform = str(previous.get("current_platform") or "")
            if current_platform in order:
                start_index = order.index(current_platform)
        else:
            create_collection_run(self.db_path, run_id=self.run_id, task_id=self.task_id, options=options, platform_states=states)

        stop_signal = _StopSignal(self.stop_event)
        collection_cfg = self.config.get("collection", {}) if isinstance(self.config.get("collection"), dict) else {}
        try:
            target_limit = int(collection_cfg.get("max_browser_targets", 3) or 3)
        except (TypeError, ValueError):
            target_limit = 3
        budget = _BrowserTargetBudget(target_limit, stop_signal) if options["execution_mode"] == "parallel_pilot" else None
        pipeline = _ScoringPipeline(self.config, stop_signal, lambda: self._emit_execution(states, all_new_ids, budget, options)) if options.get("auto_score") else None
        platform_results: list[PlatformCollectionResult] = []
        current_platform = ""
        halted = False
        try:
            remaining = order[start_index:]
            for stage in self._stage_plan(remaining, options["execution_mode"]):
                if stop_signal.is_set():
                    break
                current_platform = stage[0] if len(stage) == 1 else ""
                with self._state_lock:
                    for platform in stage:
                        states[platform]["status"] = "running"
                    self._persist(states, all_new_ids, current_platform)
                stage_results: list[PlatformCollectionResult] = []
                if len(stage) == 1:
                    platform = stage[0]
                    index = order.index(platform) + 1
                    stage_results.append(self._run_platform(platform, index, len(order), options, states, all_new_ids, stop_signal, budget))
                else:
                    with ThreadPoolExecutor(max_workers=min(2, len(stage)), thread_name_prefix="bosshunter-collect") as executor:
                        futures = {
                            executor.submit(
                                self._run_platform,
                                platform,
                                order.index(platform) + 1,
                                len(order),
                                options,
                                states,
                                list(all_new_ids),
                                stop_signal,
                                budget,
                            ): platform
                            for platform in stage
                        }
                        for future in as_completed(futures):
                            platform = futures[future]
                            try:
                                result = future.result()
                            except Exception as exc:
                                result = PlatformCollectionResult(
                                    platform, "failed", "worker_error", f"{platform} 采集工作者异常", error=str(exc)[:500],
                                )
                            stage_results.append(result)
                            if result.status == "blocked" or result.reason_code in {"browser_disconnected", "user_stopped"}:
                                stop_signal.set()
                for result in stage_results:
                    platform_results.append(result)
                    all_new_ids.extend(result.new_job_ids)
                    with self._state_lock:
                        self._finish_platform_state(states, result)
                        self._persist(states, all_new_ids, result.platform, stop_reason=result.reason_code, error=result.error)
                if pipeline is not None:
                    pipeline.submit([job_id for result in stage_results for job_id in result.new_job_ids])
                self._emit_execution(states, all_new_ids, budget, options)
                if any(result.status == "blocked" or result.reason_code in {"browser_disconnected", "user_stopped"} for result in stage_results):
                    halted = True
                    break
        finally:
            if budget is not None:
                budget.close_remaining()
            if pipeline is not None:
                pipeline.close()

        unique_new_ids = list(dict.fromkeys(str(job_id) for job_id in all_new_ids if str(job_id)))
        paused = bool(self.pause_event and self.pause_event.is_set())
        externally_stopped = bool(self.stop_event and self.stop_event.is_set())
        # Internal cancellation is used to stop the sibling of a blocked pilot
        # worker. It is not a user stop and must retain the original blocker.
        stopped = externally_stopped
        errors = any(result.status in {"blocked", "failed"} for result in platform_results)
        if pipeline is not None and pipeline.errors:
            errors = True
        shortages = any(result.status == "completed_with_shortage" for result in platform_results)
        outcome = "paused" if paused else "stopped" if stopped else "completed_with_errors" if errors else "completed_with_shortage" if shortages else "completed"
        error = "；".join(pipeline.errors) if pipeline is not None and pipeline.errors else None
        with self._state_lock:
            self._persist(
                states,
                unique_new_ids,
                current_platform if paused else "",
                status=outcome,
                stop_reason="用户暂停，可从当前平台继续" if paused else "user_stopped" if stopped else "",
                error=error,
            )
        return {
            "run_id": self.run_id,
            "status": outcome,
            "platforms": states,
            "collected_job_ids": unique_new_ids,
            "results": [result.__dict__ for result in platform_results],
            "execution": {
                "requested_mode": options.get("requested_execution_mode", options["execution_mode"]),
                "effective_mode": options["execution_mode"],
                "degraded": False,
                "degradation_reason": "",
                "active_platforms": [],
                "active_workers": 0,
                "active_browser_targets": 0,
                "browser_target_limit": budget.limit if budget is not None else 1,
            },
        }

    def _run_platform(
        self,
        platform: str,
        index: int,
        total: int,
        options: dict[str, Any],
        states: dict[str, dict[str, Any]],
        all_new_ids: list[str],
        stop_event: _StopSignal,
        budget: _BrowserTargetBudget | None,
    ) -> PlatformCollectionResult:
        conn = get_db(self.db_path)
        try:
            request = PlatformCollectionRequest(platform=platform, **options["platforms"][platform])
            processor = _SharedProcessor(
                conn,
                request,
                run_id=self.run_id,
                platform_index=index,
                platform_total=total,
                stop_event=stop_event,
                config=self.config,
                emit=lambda progress, p=platform, processor_ref=None: self._emit(
                    states, p, progress, all_new_ids, processor_ref.new_job_ids if processor_ref else []
                ),
                db_lock=self._db_lock,
            )
            processor.emit = lambda progress, p=platform, processor_ref=processor: self._emit(
                states, p, progress, all_new_ids, processor_ref.new_job_ids
            )
            hooks = CollectorHooks(
                stop_event=stop_event,
                on_list_candidate=processor.inspect,
                on_candidate=processor.save,
                on_parse_failed=lambda reason, p=processor: self._parse_failed(p, reason),
                on_event=lambda p=processor, **kwargs: p.event(**kwargs),
            )
            try:
                collector = self._collector_for(platform, conn, budget)
                result = collector.collect(request, hooks)
            except CollectionError as exc:
                result = PlatformCollectionResult(platform, "blocked", exc.code, exc.message, error=str(exc))
            except Exception as exc:
                result = PlatformCollectionResult(platform, "failed", "network_error", f"{platform} 采集失败", error=str(exc)[:500])
            result.new_job_ids = list(processor.new_job_ids)
            result.counts = self._counts(processor.progress)
            with self._state_lock:
                self._finish_platform_state(states, result, processor.progress)
            return result
        finally:
            conn.close()

    def _collector_for(self, platform: str, conn, budget: _BrowserTargetBudget | None):
        if platform == "boss" and self._uses_default_registry:
            return BossCollector(config=self.config, safety_conn=conn)
        if budget is None or not self._uses_default_registry:
            return self.registry.get(platform)
        if platform == "zhilian":
            return ZhilianCollector(browser=ZhilianBrowser(
                new_tab=budget.open, close_tab=budget.close, evaluate=evaluate, scroll=scroll, wait_for_load=wait_for_load,
                click_action=click, type_text_action=type_text, press_key_action=press_key, navigate_action=navigate,
            ))
        if platform == "51job":
            return Job51Collector(browser=Job51Browser(
                new_tab=budget.open, close_tab=budget.close, evaluate=evaluate, scroll=scroll,
                wait_for_load=wait_for_load, navigate_action=navigate,
            ))
        return self.registry.get(platform)

    @staticmethod
    def _finish_platform_state(
        states: dict[str, dict[str, Any]],
        result: PlatformCollectionResult,
        progress: CollectionProgress | None = None,
    ) -> None:
        value = states[result.platform]
        value.update({"status": result.status, "new": len(result.new_job_ids), "reason_code": result.reason_code, "message": result.message})
        if progress is not None:
            value.update({
                "percent": progress.percent, "seen": progress.seen, "duplicate": progress.duplicate,
                "filtered": progress.filtered, "parse_failed": progress.parse_failed, "save_failed": progress.save_failed,
                "keyword": progress.keyword, "city": progress.city, "page": progress.page, "max_pages": progress.max_pages,
            })

    def _emit_execution(
        self,
        states: dict[str, dict[str, Any]],
        all_new_ids: list[str],
        budget: _BrowserTargetBudget | None,
        options: dict[str, Any],
    ) -> None:
        callback = self.config.get("_workbench_collect_progress")
        if not callable(callback):
            return
        with self._state_lock:
            active = [platform for platform, value in states.items() if value.get("status") == "running"]
            callback({
                "seen": sum(int(value.get("seen") or 0) for value in states.values()),
                "new": len(dict.fromkeys(all_new_ids)),
                "duplicate": sum(int(value.get("duplicate") or 0) for value in states.values()),
                "filtered": sum(int(value.get("filtered") or 0) for value in states.values()),
                "parse_failed": sum(int(value.get("parse_failed") or 0) for value in states.values()),
                "save_failed": sum(int(value.get("save_failed") or 0) for value in states.values()),
                "progress": {
                    "run_id": self.run_id,
                    "outcome": "running",
                    "current_platform": active[0] if len(active) == 1 else "",
                    "platforms": deepcopy(states),
                    "execution": {
                        "requested_mode": options.get("requested_execution_mode", options["execution_mode"]),
                        "effective_mode": options["execution_mode"],
                        "degraded": False, "degradation_reason": "", "active_platforms": active,
                        "active_workers": len(active), "active_browser_targets": budget.active_count() if budget else 1,
                        "browser_target_limit": budget.limit if budget else 1,
                    },
                },
            })

    @staticmethod
    def _counts(progress: CollectionProgress) -> dict[str, int]:
        return {
            "seen": progress.seen, "new": progress.new, "duplicate": progress.duplicate,
            "filtered": progress.filtered, "parse_failed": progress.parse_failed, "save_failed": progress.save_failed,
        }

    def _parse_failed(self, processor: _SharedProcessor, reason: str) -> None:
        processor.progress.parse_failed += 1
        processor.event(phase="loading_detail", message=reason)

    def _emit(
        self,
        states: dict[str, dict[str, Any]],
        platform: str,
        progress: CollectionProgress,
        all_new_ids: list[str],
        platform_new_ids: list[str],
    ) -> None:
        with self._state_lock:
            progress.new = len(platform_new_ids) if progress.platform == platform else progress.new
            states[platform].update({
                "status": "running", "new": progress.new, "target": progress.target, "percent": progress.percent,
                "seen": progress.seen, "duplicate": progress.duplicate, "filtered": progress.filtered,
                "parse_failed": progress.parse_failed, "save_failed": progress.save_failed,
                "keyword": progress.keyword, "city": progress.city, "page": progress.page,
                "max_pages": progress.max_pages, "phase": progress.phase, "reason_code": progress.reason_code,
                "message": progress.message,
            })
            callback = self.config.get("_workbench_collect_progress")
            state = {
                **self._counts(progress), "progress": {
                    "run_id": self.run_id, "outcome": "running", "current_platform": platform,
                    "platform_index": progress.platform_index, "platform_total": progress.platform_total,
                    "platforms": deepcopy(states),
                },
            }
            if callable(callback):
                callback(state)
            self._persist(states, [*all_new_ids, *platform_new_ids], platform)

    def _emit_scoring(self, states: dict[str, dict[str, Any]], new_ids: list[str]) -> None:
        callback = self.config.get("_workbench_collect_progress")
        if callable(callback):
            callback({
                "seen": sum(int(value.get("seen") or 0) for value in states.values()),
                "new": len(new_ids),
                "duplicate": sum(int(value.get("duplicate") or 0) for value in states.values()),
                "filtered": sum(int(value.get("filtered") or 0) for value in states.values()),
                "parse_failed": sum(int(value.get("parse_failed") or 0) for value in states.values()),
                "save_failed": sum(int(value.get("save_failed") or 0) for value in states.values()),
                "progress": {"run_id": self.run_id, "outcome": "scoring", "current_platform": "", "platforms": deepcopy(states)},
            })

    def _persist(
        self,
        states: dict[str, dict[str, Any]],
        new_ids: list[str],
        current_platform: str,
        *,
        status: str | None = None,
        stop_reason: str | None = None,
        error: str | None = None,
    ) -> None:
        with self._state_lock:
            update_collection_run(
                self.db_path, self.run_id, status=status, platform_states=states,
                collected_job_ids=list(dict.fromkeys(new_ids)), current_platform=current_platform,
                stop_reason=stop_reason, error=error,
            )
