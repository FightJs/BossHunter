import tempfile
from pathlib import Path
from threading import Barrier, Event
from unittest import TestCase
from unittest.mock import patch

from bosshunter.collection.base import CollectorHooks
from bosshunter.collection.models import JobCandidate, PlatformCollectionResult
from bosshunter.collection.orchestrator import CollectionOrchestrator, normalize_collection_options
from bosshunter.collection.registry import CollectorRegistry
from bosshunter.db import get_db, insert_job


def _candidate(platform: str, source_id: str, title: str = "正常岗位") -> JobCandidate:
    return JobCandidate(
        platform=platform,
        source_job_id=source_id,
        title=title,
        company="示例公司",
        city="北京",
        city_code="530" if platform == "zhilian" else "101010100",
        jd="负责岗位相关工作",
        url=f"https://example.test/{platform}/{source_id}",
    )


def _options(*, order=None, auto_score=False):
    order = order or ["boss"]
    values = {}
    for platform in order:
        values[platform] = {
            "keywords": ["AI"],
            "cities": ["北京"],
            "city_codes": {"北京": "530"} if platform == "zhilian" else {"北京": "101010100"},
            "max_pages": 1,
            "sort": "default",
        }
    return {"platform_order": order, "auto_score": auto_score, "platforms": values}


class _FakeCollector:
    def __init__(self, platform, events, candidates, *, stop=False):
        self.platform = platform
        self.events = events
        self.candidates = candidates
        self.stop = stop

    def collect(self, _request, hooks: CollectorHooks):
        self.events.append(f"start:{self.platform}")
        for candidate in self.candidates:
            if hooks.stop_event and hooks.stop_event.is_set():
                return PlatformCollectionResult(self.platform, "stopped", "user_stopped", "用户已停止")
            if not hooks.on_list_candidate(candidate):
                continue
            if not hooks.on_candidate(candidate):
                self.events.append(f"target:{self.platform}")
                return PlatformCollectionResult(self.platform, "completed", "target_reached", "达到目标")
            if self.stop:
                hooks.stop_event.set()
                return PlatformCollectionResult(self.platform, "stopped", "user_stopped", "用户已停止")
        return PlatformCollectionResult(self.platform, "completed", "search_exhausted", "无更多结果")


class CollectionOrchestratorTests(TestCase):
    def test_two_platforms_are_strictly_serial_and_save_only_new_rows(self):
        events = []
        boss_candidates = [
            _candidate("boss", "duplicate"),
            _candidate("boss", "filtered", "包含黑名单词岗位"),
            _candidate("boss", "save-fail"),
            _candidate("boss", "boss-new-1"),
            _candidate("boss", "boss-new-2"),
        ]
        zhilian_candidates = [_candidate("zhilian", "zl-new-1"), _candidate("zhilian", "zl-new-2")]
        registry = CollectorRegistry({
            "boss": lambda: _FakeCollector("boss", events, boss_candidates),
            "zhilian": lambda: _FakeCollector("zhilian", events, zhilian_candidates),
        })
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "collection.db"
            db = get_db(db_path)
            try:
                insert_job(db, {**_candidate("boss", "duplicate").as_job_record()})
            finally:
                db.close()
            config = {"profile": {"deal_breakers": ["黑名单词"]}}
            real_insert = __import__("bosshunter.db", fromlist=["insert_job_if_new"]).insert_job_if_new

            def insert(record_conn, record):
                if record.get("source_job_id") == "save-fail":
                    raise RuntimeError("fixture save failure")
                return real_insert(record_conn, record)

            with patch("bosshunter.collection.orchestrator.insert_job_if_new", side_effect=insert):
                result = CollectionOrchestrator(config, db_path=db_path, registry=registry).run(
                    _options(order=["boss", "zhilian"])
                )

            db = get_db(db_path)
            try:
                rows = db.execute("SELECT id, source_platform FROM jobs ORDER BY id").fetchall()
            finally:
                db.close()

        self.assertEqual(events, ["start:boss", "start:zhilian"])
        self.assertEqual(result["platforms"]["boss"]["new"], 2)
        self.assertEqual(result["platforms"]["boss"]["duplicate"], 1)
        self.assertEqual(result["platforms"]["boss"]["filtered"], 1)
        self.assertEqual(result["platforms"]["boss"]["save_failed"], 1)
        self.assertEqual(result["platforms"]["zhilian"]["new"], 2)
        self.assertEqual(result["collected_job_ids"], ["boss-new-1", "boss-new-2", "zhilian:zl-new-1", "zhilian:zl-new-2"])
        self.assertEqual({row["source_platform"] for row in rows}, {"boss", "zhilian"})

    def test_auto_score_is_opt_in_and_receives_only_this_run_ids(self):
        candidates = [_candidate("boss", "new-1")]
        registry = CollectorRegistry({"boss": lambda: _FakeCollector("boss", [], candidates)})
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "collection.db"
            with patch("bosshunter.ai.scorer.score_jobs") as score_jobs:
                result = CollectionOrchestrator({}, db_path=db_path, registry=registry).run(
                    _options(auto_score=True)
                )
        score_jobs.assert_called_once()
        kwargs = score_jobs.call_args.kwargs
        self.assertEqual(kwargs["scope"], "selected")
        self.assertEqual(kwargs["job_ids"], ["new-1"])
        self.assertFalse(kwargs["force_rescore"])
        self.assertEqual(result["collected_job_ids"], ["new-1"])

        with tempfile.TemporaryDirectory() as tmp:
            with patch("bosshunter.ai.scorer.score_jobs") as score_jobs:
                CollectionOrchestrator({}, db_path=Path(tmp) / "collection.db", registry=registry).run(
                    _options(auto_score=False)
                )
        score_jobs.assert_not_called()

    def test_source_search_keyword_must_match_title_or_jd_before_saving(self):
        unmatched = _candidate("zhilian", "unmatched", "汽车展厅经理")
        unmatched.source_keyword = "agent"
        unmatched.jd = "负责客户接待和展厅运营"
        matched = _candidate("zhilian", "matched", "AI Agent Engineer")
        matched.source_keyword = "agent"
        registry = CollectorRegistry({"zhilian": lambda: _FakeCollector("zhilian", [], [unmatched, matched])})
        options = _options(order=["zhilian"])

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "collection.db"
            result = CollectionOrchestrator({}, db_path=db_path, registry=registry).run(options)
            db = get_db(db_path)
            try:
                rows = db.execute("SELECT id FROM jobs ORDER BY id").fetchall()
            finally:
                db.close()

        self.assertEqual(result["platforms"]["zhilian"]["filtered"], 1)
        self.assertEqual(result["collected_job_ids"], ["zhilian:matched"])
        self.assertEqual([row["id"] for row in rows], ["zhilian:matched"])

    def test_stop_event_does_not_start_the_next_platform_or_scoring(self):
        events = []
        stop_event = Event()
        registry = CollectorRegistry({
            "boss": lambda: _FakeCollector("boss", events, [_candidate("boss", "one")], stop=True),
            "zhilian": lambda: _FakeCollector("zhilian", events, [_candidate("zhilian", "two")]),
        })
        with tempfile.TemporaryDirectory() as tmp:
            config = {"_workbench_stop_event": stop_event}
            with patch("bosshunter.ai.scorer.score_jobs") as score_jobs:
                result = CollectionOrchestrator(config, db_path=Path(tmp) / "collection.db", registry=registry).run(
                    _options(order=["boss", "zhilian"], auto_score=True)
                )
        self.assertEqual(events, ["start:boss"])
        self.assertEqual(result["status"], "stopped")
        self.assertNotIn("start:zhilian", events)
        score_jobs.assert_not_called()

    def test_legacy_search_values_override_empty_platform_defaults(self):
        result = normalize_collection_options({
            "search": {"keywords": ["后端"], "cities": ["上海"]},
            "platforms": {"boss": {"search": {"keywords": [], "cities": []}}},
            "profile": {"target_cities": ["北京"]},
        })
        self.assertEqual(result["platforms"]["boss"]["keywords"], ["后端"])
        self.assertEqual(result["platforms"]["boss"]["cities"], ["上海"])

    def test_zhilian_city_code_is_resolved_from_city_name(self):
        result = normalize_collection_options({}, {
            "platform_order": ["zhilian"],
            "auto_score": False,
            "platforms": {
                "zhilian": {
                    "keywords": ["AI"],
                    "cities": ["北京市"],
                    "max_pages": 1,
                    "sort": "default",
                },
            },
        })
        self.assertEqual(result["platforms"]["zhilian"]["city_codes"], {"北京市": "530"})

        legacy_boss_code = normalize_collection_options({}, {
            "platform_order": ["zhilian"],
            "auto_score": False,
            "platforms": {
                "zhilian": {
                    "keywords": ["AI"],
                    "cities": ["北京"],
                    "city_codes": {"北京": "101010100"},
                    "max_pages": 1,
                    "sort": "default",
                },
            },
        })
        self.assertEqual(legacy_boss_code["platforms"]["zhilian"]["city_codes"], {"北京": "530"})

    def test_disabled_zhilian_is_not_in_implicit_default_queue(self):
        result = normalize_collection_options({
            "search": {"keywords": ["后端"], "cities": ["北京"]},
            "collection": {"default_order": ["boss", "zhilian"]},
            "platforms": {"zhilian": {"enabled": False, "search": {}}},
        })
        self.assertEqual(result["platform_order"], ["boss"])

    def test_parallel_pilot_runs_only_the_non_boss_stage_concurrently(self):
        barrier = Barrier(2)
        started: list[str] = []

        class ParallelCollector:
            def __init__(self, platform: str):
                self.platform = platform

            def collect(self, _request, hooks: CollectorHooks):
                started.append(self.platform)
                barrier.wait(timeout=1)
                candidate = _candidate(self.platform, f"{self.platform}-new")
                if hooks.on_list_candidate(candidate):
                    hooks.on_candidate(candidate)
                return PlatformCollectionResult(self.platform, "completed", "search_exhausted", "完成")

        registry = CollectorRegistry({
            "zhilian": lambda: ParallelCollector("zhilian"),
            "51job": lambda: ParallelCollector("51job"),
        })
        options = _options(order=["zhilian", "51job"])
        options["execution_mode"] = "parallel_pilot"
        config = {"collection": {"parallel_pilot_enabled": True, "max_browser_targets": 3}}
        with tempfile.TemporaryDirectory() as tmp:
            result = CollectionOrchestrator(config, db_path=Path(tmp) / "collection.db", registry=registry).run(options)

        self.assertEqual(set(started), {"zhilian", "51job"})
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["execution"]["effective_mode"], "parallel_pilot")
        self.assertEqual(set(result["collected_job_ids"]), {"zhilian:zhilian-new", "51job:51job-new"})

    def test_parallel_boss_zhilian_runs_the_two_platforms_concurrently_when_enabled(self):
        barrier = Barrier(2)
        started: list[str] = []

        class ParallelCollector:
            def __init__(self, platform: str):
                self.platform = platform

            def collect(self, _request, hooks: CollectorHooks):
                started.append(self.platform)
                barrier.wait(timeout=1)
                candidate = _candidate(self.platform, f"{self.platform}-new")
                if hooks.on_list_candidate(candidate):
                    hooks.on_candidate(candidate)
                return PlatformCollectionResult(self.platform, "completed", "search_exhausted", "完成")

        registry = CollectorRegistry({
            "boss": lambda: ParallelCollector("boss"),
            "zhilian": lambda: ParallelCollector("zhilian"),
        })
        options = _options(order=["boss", "zhilian"])
        options["execution_mode"] = "parallel_boss_zhilian"
        config = {"collection": {"parallel_boss_zhilian_enabled": True, "max_browser_targets": 2}}
        with tempfile.TemporaryDirectory() as tmp:
            result = CollectionOrchestrator(config, db_path=Path(tmp) / "collection.db", registry=registry).run(options)

        self.assertEqual(set(started), {"boss", "zhilian"})
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["execution"]["effective_mode"], "parallel_boss_zhilian")
        self.assertEqual(set(result["collected_job_ids"]), {"boss-new", "zhilian:zhilian-new"})

    def test_parallel_all_platforms_runs_three_platforms_concurrently_when_enabled(self):
        barrier = Barrier(3)
        started: list[str] = []

        class ParallelCollector:
            def __init__(self, platform: str):
                self.platform = platform

            def collect(self, _request, hooks: CollectorHooks):
                started.append(self.platform)
                barrier.wait(timeout=1)
                candidate = _candidate(self.platform, f"{self.platform}-new")
                if hooks.on_list_candidate(candidate):
                    hooks.on_candidate(candidate)
                return PlatformCollectionResult(self.platform, "completed", "search_exhausted", "完成")

        registry = CollectorRegistry({platform: (lambda platform=platform: ParallelCollector(platform)) for platform in ("boss", "zhilian", "51job")})
        options = _options(order=["boss", "zhilian", "51job"])
        options["execution_mode"] = "parallel_all_platforms"
        config = {"collection": {"parallel_all_platforms_enabled": True, "max_browser_targets": 3}}
        with tempfile.TemporaryDirectory() as tmp:
            result = CollectionOrchestrator(config, db_path=Path(tmp) / "collection.db", registry=registry).run(options)

        self.assertEqual(set(started), {"boss", "zhilian", "51job"})
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["execution"]["effective_mode"], "parallel_all_platforms")
        self.assertEqual(set(result["collected_job_ids"]), {"boss-new", "zhilian:zhilian-new", "51job:51job-new"})

    def test_pipelined_scoring_starts_while_the_next_platform_collects(self):
        score_started = Event()

        class BossCollectorFixture:
            platform = "boss"

            def collect(self, _request, hooks: CollectorHooks):
                candidate = _candidate("boss", "boss-new")
                if hooks.on_list_candidate(candidate):
                    hooks.on_candidate(candidate)
                return PlatformCollectionResult("boss", "completed", "search_exhausted", "完成")

        class ZhilianCollectorFixture:
            platform = "zhilian"

            def collect(self, _request, hooks: CollectorHooks):
                if not score_started.wait(1):
                    return PlatformCollectionResult("zhilian", "failed", "score_not_started", "评分流水线未启动")
                candidate = _candidate("zhilian", "zhilian-new")
                if hooks.on_list_candidate(candidate):
                    hooks.on_candidate(candidate)
                return PlatformCollectionResult("zhilian", "completed", "search_exhausted", "完成")

        registry = CollectorRegistry({
            "boss": BossCollectorFixture,
            "zhilian": ZhilianCollectorFixture,
        })
        options = _options(order=["boss", "zhilian"], auto_score=True)
        options["execution_mode"] = "pipelined"
        config = {"collection": {"score_batch_size": 1, "score_flush_ms": 50}}
        with tempfile.TemporaryDirectory() as tmp, patch("bosshunter.ai.scorer.score_jobs", side_effect=lambda *_args, **_kwargs: score_started.set() or (1, 0)):
            result = CollectionOrchestrator(config, db_path=Path(tmp) / "collection.db", registry=registry).run(options)

        self.assertEqual(result["status"], "completed")
        self.assertTrue(score_started.is_set())

    def test_parallel_pilot_falls_back_when_the_release_guard_is_disabled(self):
        options = _options(order=["zhilian", "51job"])
        options["execution_mode"] = "parallel_pilot"
        normalized = normalize_collection_options({"collection": {"parallel_pilot_enabled": False}}, options)
        self.assertEqual(normalized["execution_mode"], "parallel_pilot")
        registry = CollectorRegistry({
            "zhilian": lambda: _FakeCollector("zhilian", [], []),
            "51job": lambda: _FakeCollector("51job", [], []),
        })
        with tempfile.TemporaryDirectory() as tmp:
            result = CollectionOrchestrator({"collection": {"parallel_pilot_enabled": False}}, db_path=Path(tmp) / "collection.db", registry=registry).run(options)
        self.assertEqual(result["execution"]["effective_mode"], "safe_serial")
        self.assertTrue(result["execution"]["degraded"])

    def test_parallel_pilot_isolates_a_blocked_platform_outcome(self):
        barrier = Barrier(2)

        class BlockingCollector:
            platform = "zhilian"

            def collect(self, _request, _hooks: CollectorHooks):
                barrier.wait(timeout=1)
                return PlatformCollectionResult("zhilian", "blocked", "rate_limit", "智联限流")

        class CompletingCollector:
            platform = "51job"

            def collect(self, _request, hooks: CollectorHooks):
                barrier.wait(timeout=1)
                candidate = _candidate("51job", "still-runs")
                if hooks.on_list_candidate(candidate):
                    hooks.on_candidate(candidate)
                return PlatformCollectionResult("51job", "completed", "search_exhausted", "完成")

        registry = CollectorRegistry({"zhilian": BlockingCollector, "51job": CompletingCollector})
        options = _options(order=["zhilian", "51job"])
        options["execution_mode"] = "parallel_pilot"
        with tempfile.TemporaryDirectory() as tmp:
            result = CollectionOrchestrator(
                {"collection": {"parallel_pilot_enabled": True}},
                db_path=Path(tmp) / "collection.db",
                registry=registry,
            ).run(options)

        self.assertEqual(result["status"], "completed_with_errors")
        self.assertEqual(next(item for item in result["results"] if item["platform"] == "zhilian")["reason_code"], "rate_limit")
        self.assertEqual(result["platforms"]["51job"]["status"], "completed")
        self.assertEqual(result["collected_job_ids"], ["51job:still-runs"])
