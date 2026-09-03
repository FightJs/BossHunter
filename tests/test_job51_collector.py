import json
from unittest import TestCase

from bosshunter.collection.base import CollectorHooks
from bosshunter.collection.models import PlatformCollectionRequest
from bosshunter.collection.orchestrator import normalize_collection_options
from bosshunter.collection.platforms.job51 import JS_EXTRACT_DETAIL, JS_EXTRACT_LIST, Job51Browser, Job51Collector, get_51job_city_code
from bosshunter.collection.text import clean_job_description


class Job51CollectorTests(TestCase):
    def test_list_script_skips_company_profiles_and_builds_detail_urls(self):
        self.assertIn('a[href*="jobs.51job.com/"]', JS_EXTRACT_LIST)
        self.assertIn("url: jobUrl", JS_EXTRACT_LIST)
        # Current SPA cards only hyperlink the company profile
        # (jobs.51job.com/all/co...); a numeric job id must be used to build
        # the canonical job-detail URL instead.
        self.assertIn("jobUrl = 'https://jobs.51job.com/all/' + id + '.html';", JS_EXTRACT_LIST)
        self.assertIn("/\\/all\\/co[A-Za-z0-9_-]+\\.html$/", JS_EXTRACT_LIST)
        self.assertNotIn("jobs.51job.com/shanghai/", JS_EXTRACT_LIST)
        self.assertNotIn("全国招聘", JS_EXTRACT_LIST)

    def test_detail_script_targets_job_description_without_footer_noise(self):
        self.assertIn(".bmsg.job_msg.inbox > div:first-child", JS_EXTRACT_DETAIL)
        self.assertNotIn("body.slice(anchor)", JS_EXTRACT_DETAIL)

    def test_company_profile_url_is_normalized_to_job_detail_url(self):
        candidate = Job51Collector._candidate_from_list(
            {
                "source_job_id": "173263084",
                "title": "管培生-AI开发方向",
                "company": "利欧集团股份有限公司",
                "salary": "1.5-2万",
                "city": "杭州",
                "url": "https://jobs.51job.com/all/coUzQFYVYwADwGagxvBmoGOA.html",
            },
            "杭州",
            "agent",
        )
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.url, "https://jobs.51job.com/all/173263084.html")
        self.assertEqual(candidate.company, "利欧集团股份有限公司")

    def test_company_profile_without_numeric_id_is_dropped(self):
        for company_url in (
            "https://jobs.51job.com/all/coUzQFYVYwADwGagxvBmoGOA.html",
            "https://jobs.51job.com/all/coB2BSNl4_ADZVMgVgVDMEOg.html",
        ):
            candidate = Job51Collector._candidate_from_list(
                {
                    "source_job_id": company_url.rsplit("/", 1)[-1].removesuffix(".html"),
                    "title": "利欧集团股份有限公司",
                    "url": company_url,
                },
                "上海",
                "AI",
            )
            self.assertIsNone(candidate)

    def test_existing_job_detail_urls_are_kept(self):
        candidate = Job51Collector._candidate_from_list(
            {
                "source_job_id": "job-1",
                "title": "AI 产品经理",
                "company": "示例公司",
                "url": "https://jobs.51job.com/shanghai/job-1.html",
            },
            "上海",
            "AI 产品",
        )
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate.url, "https://jobs.51job.com/shanghai/job-1.html")

    def test_detail_title_strips_recruiter_job_number_suffix(self):
        cases = {
            "管培生-AI开发方向 (职位编号：A105006)": "管培生-AI开发方向",
            "AI开发岗（职位编号：184930）": "AI开发岗",
            "AI 工程师（杭州） (职位编号: 3)": "AI 工程师（杭州）",
            "普通职位名称": "普通职位名称",
            "": "",
        }
        for raw, expected in cases.items():
            self.assertEqual(Job51Collector._clean_detail_title(raw), expected)

    def test_city_and_option_defaults_are_fail_closed(self):
        self.assertEqual(get_51job_city_code("北京市"), "010000")
        self.assertEqual(get_51job_city_code("上海市"), "020000")
        self.assertEqual(get_51job_city_code("广州市"), "030200")
        self.assertEqual(get_51job_city_code("深圳"), "040000")
        for city, code in {
            "成都": "090200", "重庆": "060000", "杭州": "080200", "武汉": "180200",
            "西安": "200200", "苏州": "070300", "南京": "070200", "天津": "050000",
            "郑州": "170200", "长沙": "190200", "东莞": "030800", "宁波": "080300",
            "青岛": "120200", "合肥": "080100", "佛山": "030600",
        }.items():
            self.assertEqual(get_51job_city_code(city), code)
        options = normalize_collection_options({}, {
            "platform_order": ["51job"],
            "platforms": {"51job": {"keywords": ["AI 产品"], "cities": ["上海"]}},
        })
        search = options["platforms"]["51job"]
        self.assertEqual(search["city_codes"], {"上海": "020000"})
        self.assertEqual(search["max_pages"], 1)
        self.assertNotIn("target_count", search)

    def test_beijing_search_uses_verified_51job_area_code(self):
        request = PlatformCollectionRequest(
            "51job",
            ["AI 产品"],
            ["北京"],
            {"北京": "010000"},
            max_pages=1,
        )

        url = Job51Collector.build_search_url(request, "北京", "AI 产品")

        self.assertIn("jobArea=010000", url)
        self.assertIn("keyword=AI%20%E4%BA%A7%E5%93%81", url)

    def test_collection_uses_platform_identity_and_rate_limit(self):
        list_payload = json.dumps({"status": "ready", "jobs": [
            {
                "source_job_id": "job-1",
                "title": "AI 产品经理",
                "company": "示例公司",
                "city": "上海",
                "url": "https://jobs.51job.com/shanghai/job-1.html",
            },
            {
                "source_job_id": "job-2",
                "title": "AI 产品运营",
                "company": "示例公司",
                "city": "上海",
                "url": "https://jobs.51job.com/shanghai/job-2.html",
            },
        ]}, ensure_ascii=False)
        detail_payload = json.dumps({
            "status": "ready",
            "title": "AI 产品",
            "company": "示例公司",
            "city": "上海",
            "jd": "[岗位kanzhun职责]负责需求分析，来自BOSS直聘要求会 SQL。",
        }, ensure_ascii=False)
        sleeps: list[float] = []

        def evaluate(_target, script):
            return list_payload if ".joblist-item" in script else detail_payload

        browser = Job51Browser(
            new_tab=lambda url, **_kwargs: url,
            close_tab=lambda _target: True,
            evaluate=evaluate,
            scroll=lambda *_args, **_kwargs: True,
            wait_for_load=lambda *_args, **_kwargs: True,
        )
        collected = []
        hooks = CollectorHooks(
            stop_event=None,
            on_list_candidate=lambda _candidate: True,
            on_candidate=lambda candidate: collected.append(candidate) or len(collected) < 2,
            on_parse_failed=lambda reason: self.fail(reason),
            on_event=lambda **_kwargs: None,
        )
        result = Job51Collector(
            browser=browser,
            sleep=sleeps.append,
            uniform=lambda _low, _high: 13.0,
        ).collect(
            PlatformCollectionRequest("51job", ["AI 产品"], ["上海"], {"上海": "020000"}, max_pages=1),
            hooks,
        )

        self.assertEqual(result.reason_code, "callback_stopped")
        self.assertEqual([candidate.storage_id for candidate in collected], ["51job:job-1", "51job:job-2"])
        self.assertEqual(sleeps, [13.0])
        self.assertEqual(clean_job_description(collected[0].jd), "负责需求分析，要求会 SQL。")

    def test_collection_uses_configured_51job_delays(self):
        list_payload = json.dumps({"status": "ready", "jobs": [
            {
                "source_job_id": "job-c1",
                "title": "AI 产品经理",
                "company": "示例公司",
                "city": "上海",
                "url": "https://jobs.51job.com/shanghai/job-c1.html",
            },
            {
                "source_job_id": "job-c2",
                "title": "AI 产品运营",
                "company": "示例公司",
                "city": "上海",
                "url": "https://jobs.51job.com/shanghai/job-c2.html",
            },
        ]}, ensure_ascii=False)
        detail_payload = json.dumps({
            "status": "ready",
            "title": "AI 产品",
            "company": "示例公司",
            "city": "上海",
            "jd": "负责需求分析。",
        }, ensure_ascii=False)
        sleeps: list[float] = []

        def evaluate(_target, script):
            return list_payload if ".joblist-item" in script else detail_payload

        browser = Job51Browser(
            new_tab=lambda url, **_kwargs: url,
            close_tab=lambda _target: True,
            evaluate=evaluate,
            scroll=lambda *_args, **_kwargs: True,
            wait_for_load=lambda *_args, **_kwargs: True,
        )
        collected = []
        hooks = CollectorHooks(
            stop_event=None,
            on_list_candidate=lambda _candidate: True,
            on_candidate=lambda candidate: collected.append(candidate) or len(collected) < 2,
            on_parse_failed=lambda reason: self.fail(reason),
            on_event=lambda **_kwargs: None,
        )
        result = Job51Collector(
            browser=browser,
            sleep=sleeps.append,
            uniform=lambda _low, _high: 18.0,
            config={"collection": {"job51_detail_delay_min_seconds": 18, "job51_detail_delay_max_seconds": 26}},
        ).collect(
            PlatformCollectionRequest("51job", ["AI 产品"], ["上海"], {"上海": "020000"}, max_pages=1),
            hooks,
        )

        self.assertEqual(result.reason_code, "callback_stopped")
        self.assertEqual(sleeps, [18.0])

    def test_verification_page_stops_platform(self):
        browser = Job51Browser(
            new_tab=lambda url, **_kwargs: url,
            close_tab=lambda _target: True,
            evaluate=lambda _target, _script: json.dumps({"status": "blocked", "jobs": []}),
            scroll=lambda *_args, **_kwargs: True,
            wait_for_load=lambda *_args, **_kwargs: True,
        )
        hooks = CollectorHooks(
            stop_event=None,
            on_list_candidate=lambda _candidate: True,
            on_candidate=lambda _candidate: True,
            on_parse_failed=lambda _reason: None,
            on_event=lambda **_kwargs: None,
        )
        result = Job51Collector(browser=browser).collect(
            PlatformCollectionRequest("51job", ["AI"], ["上海"], {"上海": "020000"}, max_pages=1),
            hooks,
        )
        self.assertEqual(result.status, "blocked")
        self.assertEqual(result.reason_code, "rate_limit")

    def test_collection_waits_for_spa_list_render(self):
        evaluations = 0
        sleeps = []

        def evaluate(_target, script):
            nonlocal evaluations
            if ".joblist-item" in script:
                evaluations += 1
                if evaluations < 3:
                    return json.dumps({"status": "waiting", "jobs": []})
                return json.dumps({"status": "ready", "jobs": [{
                    "source_job_id": "job-spa",
                    "title": "AI 运营",
                    "company": "示例公司",
                    "city": "上海",
                    "url": "https://jobs.51job.com/shanghai/job-spa.html",
                }]})
            return json.dumps({
                "status": "ready", "title": "AI 运营", "company": "示例公司",
                "city": "上海", "jd": "负责 AI 产品运营与数据分析。",
            })

        browser = Job51Browser(
            new_tab=lambda url, **_kwargs: url,
            close_tab=lambda _target: True,
            evaluate=evaluate,
            scroll=lambda *_args, **_kwargs: True,
            wait_for_load=lambda *_args, **_kwargs: True,
        )
        hooks = CollectorHooks(
            stop_event=None,
            on_list_candidate=lambda _candidate: True,
            on_candidate=lambda _candidate: False,
            on_parse_failed=lambda reason: self.fail(reason),
            on_event=lambda **_kwargs: None,
        )

        result = Job51Collector(browser=browser, sleep=sleeps.append).collect(
            PlatformCollectionRequest("51job", ["AI运营"], ["上海"], {"上海": "020000"}, max_pages=1),
            hooks,
        )

        self.assertEqual(result.reason_code, "callback_stopped")
        self.assertEqual(evaluations, 3)
        self.assertEqual(sleeps, [0.75, 0.75])


class JobDescriptionCleanupTests(TestCase):
    def test_known_platform_source_noise_is_removed(self):
        dirty = "[岗位kanzhun职责]1.公司业务后台开发 来自BOSS直聘 2.掌握 SQL"
        self.assertEqual(clean_job_description(dirty), "1.公司业务后台开发 2.掌握 SQL")
