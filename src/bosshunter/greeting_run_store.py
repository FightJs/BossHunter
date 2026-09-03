"""Persistence helpers for recoverable greeting-generation runs.

Greeting generation is intentionally a database-only/AI workflow, but the
worker itself lives in memory.  Keeping the selected and remaining job IDs in
SQLite means a pause survives an application restart and can be resumed from
the last completed job instead of starting the batch over.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from bosshunter.db import get_db


TERMINAL_RUN_STATUSES = {"completed", "completed_with_errors", "failed", "stopped"}


def _json_text(value: Any, default: Any) -> str:
	try:
		return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
	except (TypeError, ValueError):
		return json.dumps(default, ensure_ascii=False, separators=(",", ":"))


def _decode(value: Any, default: Any) -> Any:
	try:
		return json.loads(value) if value else default
	except (TypeError, json.JSONDecodeError):
		return default


def _public_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
	if not row:
		return None
	result = dict(row)
	result["options"] = _decode(result.pop("options_json", "{}"), {})
	result["remaining_job_ids"] = _decode(result.pop("remaining_job_ids_json", "[]"), [])
	result["progress"] = _decode(result.pop("progress_json", "{}"), {})
	result["recoverable"] = result.get("status") == "paused" and bool(result["remaining_job_ids"])
	return result


def create_greeting_run(
	db_path: Path,
	*,
	run_id: str,
	options: dict[str, Any],
	job_ids: list[str],
	task_id: str = "",
) -> dict[str, Any]:
	"""Create a pending run with a frozen selection of jobs."""
	db = get_db(db_path)
	try:
		db.execute(
			"""INSERT OR REPLACE INTO greeting_runs
               (id, task_id, status, options_json, remaining_job_ids_json, progress_json)
               VALUES (?, ?, 'pending', ?, ?, ?)""",
			(
				run_id,
				task_id,
				_json_text(options, {}),
				_json_text(job_ids, []),
				_json_text({
					"selected": len(job_ids),
					"completed": 0,
					"total": len(job_ids),
					"generated": 0,
					"failed": 0,
					"remaining": len(job_ids),
					"current_job": None,
				}, {}),
			),
		)
		db.commit()
	finally:
		db.close()
	return get_greeting_run(db_path, run_id) or {}


def update_greeting_run(
	db_path: Path,
	run_id: str,
	*,
	status: str | None = None,
	task_id: str | None = None,
	remaining_job_ids: list[str] | None = None,
	progress: dict[str, Any] | None = None,
	pause_reason: str | None = None,
	error: str | None = None,
	allow_reopen: bool = False,
) -> dict[str, Any] | None:
	"""Update a run checkpoint without allowing stale workers to reopen it."""
	assignments = ["updated_at = CURRENT_TIMESTAMP"]
	params: list[Any] = []
	for column, value in (
		("status", status),
		("task_id", task_id),
		("pause_reason", pause_reason),
		("error", error),
	):
		if value is not None:
			assignments.append(f"{column} = ?")
			params.append(str(value)[:1000])
	if remaining_job_ids is not None:
		assignments.append("remaining_job_ids_json = ?")
		params.append(_json_text(remaining_job_ids, []))
	if progress is not None:
		assignments.append("progress_json = ?")
		params.append(_json_text(progress, {}))
	if status in TERMINAL_RUN_STATUSES:
		assignments.append("finished_at = CURRENT_TIMESTAMP")
	elif status == "running":
		assignments.extend(["finished_at = NULL", "pause_reason = NULL", "error = NULL"])
	params.append(run_id)
	where = "id = ?"
	if status in {"running", "paused"} and not allow_reopen:
		where += " AND status NOT IN ('completed', 'completed_with_errors', 'failed', 'stopped')"
	db = get_db(db_path)
	try:
		db.execute(f"UPDATE greeting_runs SET {', '.join(assignments)} WHERE {where}", params)
		db.commit()
	finally:
		db.close()
	return get_greeting_run(db_path, run_id)


def get_greeting_run(db_path: Path, run_id: str) -> dict[str, Any] | None:
	db = get_db(db_path)
	try:
		row = db.execute("SELECT * FROM greeting_runs WHERE id = ?", (run_id,)).fetchone()
		return _public_row(dict(row)) if row else None
	finally:
		db.close()


def list_greeting_runs(db_path: Path, *, limit: int = 20) -> list[dict[str, Any]]:
	db = get_db(db_path)
	try:
		rows = db.execute(
			"SELECT * FROM greeting_runs ORDER BY created_at DESC LIMIT ?",
			(max(1, min(int(limit), 100)),),
		).fetchall()
		return [_public_row(dict(row)) or {} for row in rows]
	finally:
		db.close()


def mark_orphaned_greeting_runs_paused(db_path: Path) -> int:
	"""Turn workers that disappeared with the process into resumable runs."""
	db = get_db(db_path)
	try:
		cursor = db.execute(
			"""UPDATE greeting_runs
               SET status = 'paused',
                   pause_reason = '应用已重启，可从剩余岗位继续',
                   updated_at = CURRENT_TIMESTAMP
               WHERE status IN ('pending', 'running')"""
		)
		db.commit()
		return int(cursor.rowcount)
	finally:
		db.close()
