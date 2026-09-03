"""Fail-closed 51job collector for the shared multi-platform pipeline.

The collector intentionally implements collection only.  It does not attempt
to solve verification challenges, imitate human behaviour, send messages, or
resume automatically after a risk signal.  Any WAF, slider, silent throttle,
or unexpected page state stops the current platform run.
"""

from __future__ import annotations

import json
import random
import re
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import quote

from bosshunter.browser import close_tab, evaluate, navigate as browser_navigate, new_tab, scroll, wait_for_load
from bosshunter.collection.base import CollectionError, CollectorHooks
from bosshunter.collection.models import JobCandidate, PlatformCollectionRequest, PlatformCollectionResult


SEARCH_URL = "https://we.51job.com/pc/search?jobArea={area}&keyword={keyword}"
DETAIL_DELAY_MIN_SECONDS = 12.0
DETAIL_DELAY_MAX_SECONDS = 20.0
PAGE_DELAY_MIN_SECONDS = 30.0
PAGE_DELAY_MAX_SECONDS = 45.0
RENDER_POLL_INTERVAL_SECONDS = 0.75
RENDER_POLL_ATTEMPTS = 10
# jobs.51job.com/all/co... URLs point to the company profile page, not a
# job detail. They must never be opened as a detail page.
COMPANY_PAGE_RE = re.compile(r"/all/co[A-Za-z0-9_-]+\.html$")
DETAIL_URL_TEMPLATE = "https://jobs.51job.com/all/{job_id}.html"
# Detail pages append recruiter-internal job numbers to the title, e.g.
# "AI 工程师 (职位编号：12345)"; drop that boilerplate before storing.
DETAIL_TITLE_NOISE = re.compile(r"\s*[（(]\s*职位编号\s*[：:][^）)]*[）)]\s*$")


def _delay_seconds(value: Any, default: float, minimum: float = 1.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = default
    return max(parsed, minimum)


# Only codes verified by the contributed implementation are bundled. Unknown
# cities are rejected instead of guessing or reusing another platform's code.
CITY_SNAPSHOT = (
    {"name": "北京", "code": "010000"},
    {"name": "上海", "code": "020000"},
    {"name": "广州", "code": "030200"},
    {"name": "深圳", "code": "040000"},
    {"name": "成都", "code": "090200"},
    {"name": "重庆", "code": "060000"},
    {"name": "杭州", "code": "080200"},
    {"name": "武汉", "code": "180200"},
    {"name": "西安", "code": "200200"},
    {"name": "苏州", "code": "070300"},
    {"name": "南京", "code": "070200"},
    {"name": "天津", "code": "050000"},
    {"name": "郑州", "code": "170200"},
    {"name": "长沙", "code": "190200"},
    {"name": "东莞", "code": "030800"},
    {"name": "宁波", "code": "080300"},
    {"name": "青岛", "code": "120200"},
    {"name": "合肥", "code": "080100"},
    {"name": "佛山", "code": "030600"},
)


def load_51job_city_snapshot() -> dict[str, Any]:
    return {
        "schema": "bosshunter.51job_cities.v1",
        "source": "verified_snapshot",
        "note": "当前内置一线及新一线城市的 51job 城市编码；其他城市需核验后再加入。",
        "cities": [dict(item) for item in CITY_SNAPSHOT],
    }


def get_51job_city_code(city: str) -> str | None:
    normalized = str(city or "").strip().removesuffix("市")
    for item in CITY_SNAPSHOT:
        if item["name"].removesuffix("市") == normalized:
            return item["code"]
    return None


JS_EXTRACT_LIST = r"""
(function () {
    var text = (document.body && document.body.innerText) || '';
    var blocked = /滑动验证页面|请按住滑块|访问验证|访问频繁|请稍后再试/.test(text + ' ' + document.title);
    if (blocked) return JSON.stringify({status: 'blocked', jobs: []});
    var cards = Array.prototype.slice.call(document.querySelectorAll('.joblist-item'));
    if (!cards.length) {
        // 51job is an SPA: the shell title can be present before results are
        // rendered. Do not infer throttling from the title alone; only the
        // explicit verification/rate-limit markers above are fail-closed.
        return JSON.stringify({status: 'waiting', jobs: []});
    }
    var jobs = [];
    for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var jobDiv = card.querySelector('.joblist-item-job, [class*="jobname"], [class*="job-name"]');
        var dataNode = jobDiv ? (jobDiv.querySelector('[sensorsdata]') || jobDiv) : card.querySelector('[sensorsdata]');
        var meta = {};
        try { meta = JSON.parse((dataNode && dataNode.getAttribute('sensorsdata')) || '{}'); } catch (_) {}
        var id = String(meta.jobId || '').trim();
        var title = String(meta.jobTitle || '').replace(/^招聘/, '').trim();
        // The current SPA cards only hyperlink the company profile
        // (jobs.51job.com/all/co...); the job title itself is a plain span.
        // Prefer a real job-detail link when one exists (older layouts),
        // otherwise build the canonical detail URL from the numeric job id.
        var jobUrl = '';
        var cardLinks = card.querySelectorAll('a[href*="jobs.51job.com/"]');
        for (var j = 0; j < cardLinks.length; j++) {
            var href = String(cardLinks[j].href || '').trim();
            if (/\/all\/co[A-Za-z0-9_-]+\.html$/.test(href)) continue;
            jobUrl = href;
            break;
        }
        if (!jobUrl && /^\d+$/.test(id)) {
            jobUrl = 'https://jobs.51job.com/all/' + id + '.html';
        }
        if (!id || !title || !/^https:\/\/jobs\.51job\.com\//.test(jobUrl) || /APP下载|访问验证/.test(title)) continue;
        var companyNode = card.querySelector('[class*="company"], [class*="cname"], [class*="comname"], .comp');
        var company = companyNode ? String(companyNode.innerText || '').trim().split('\n')[0] : '';
        var area = String(meta.jobArea || '').trim();
        var city = (area.split('·')[0] || '').trim();
        var experience = [meta.jobYear || '', meta.jobDegree || ''].filter(Boolean).join('·');
        jobs.push({
            source_job_id: id,
            title: title,
            company: company,
            salary: String(meta.jobSalary || '').trim(),
            city: city,
            experience: experience,
            url: jobUrl
        });
    }
    return JSON.stringify({status: jobs.length ? 'ready' : 'selector_changed', jobs: jobs});
})()
"""


JS_EXTRACT_DETAIL = r"""
(function () {
    var body = (document.body && document.body.innerText) || '';
    var pageText = body + ' ' + (document.title || '');
    if (/滑动验证页面|请按住滑块|访问验证|访问频繁|请稍后再试/.test(pageText)) {
        return JSON.stringify({status: 'blocked'});
    }
    if (/当前职位审核中或已下线|职位已下线/.test(pageText)) {
        return JSON.stringify({status: 'offline'});
    }
    var jdNode = document.querySelector('.bmsg.job_msg.inbox > div:first-child, .bmsg.job_msg.inbox');
    var jd = jdNode ? String(jdNode.innerText || '').replace(/\s+/g, ' ').trim() : '';
    var titleNode = document.querySelector('.jTitle h1, h1[title], [class*="job-name"]');
    var salaryNode = document.querySelector('.jTitle strong, [class*="salary"]');
    var companyNode = document.querySelector('[class*="company"] a, [class*="cname"] a, .comp');
    var areaNode = document.querySelector('.msg.ltype .type_2, [class*="area"], [class*="location"]');
    return JSON.stringify({
        status: jd ? 'ready' : 'selector_changed',
        title: titleNode ? String(titleNode.innerText || '').replace(/^招聘/, '').trim() : '',
        salary: salaryNode ? String(salaryNode.innerText || '').trim() : '',
        company: companyNode ? String(companyNode.innerText || '').trim() : '',
        city: areaNode ? String(areaNode.innerText || '').trim() : '',
        jd: jd,
        url: location.href
    });
})()
"""


JS_CLICK_NEXT = r"""
(function () {
    var button = document.querySelector('button.btn-next');
    if (!button || button.disabled || /disabled|is-disabled/.test(button.className || '')) return false;
    button.click();
    return true;
})()
"""


@dataclass
class Job51Browser:
    new_tab: Callable[..., str | None] = new_tab
    close_tab: Callable[[str], bool] = close_tab
    evaluate: Callable[..., Any] = evaluate
    scroll: Callable[..., bool] = scroll
    wait_for_load: Callable[..., bool] = wait_for_load
    navigate_action: Callable[[str, str], bool] | None = None


def _payload(raw: Any) -> dict[str, Any]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return {}
    return raw if isinstance(raw, dict) else {}


class Job51Collector:
    platform = "51job"

    def __init__(
        self,
        *,
        browser: Job51Browser | None = None,
        sleep: Callable[[float], None] = time.sleep,
        uniform: Callable[[float, float], float] = random.SystemRandom().uniform,
        detail_delay_range: tuple[float, float] | None = None,
        page_delay_range: tuple[float, float] | None = None,
        config: dict[str, Any] | None = None,
    ):
        self.browser = browser or Job51Browser(navigate_action=browser_navigate)
        self.sleep = sleep
        self.uniform = uniform
        collection_cfg = config.get("collection", {}) if isinstance(config, dict) else {}
        if detail_delay_range is not None:
            self.detail_delay_range = detail_delay_range
        else:
            detail_min = _delay_seconds(
                collection_cfg.get("job51_detail_delay_min_seconds"),
                DETAIL_DELAY_MIN_SECONDS,
            )
            detail_max = max(
                detail_min,
                _delay_seconds(
                    collection_cfg.get("job51_detail_delay_max_seconds"),
                    DETAIL_DELAY_MAX_SECONDS,
                ),
            )
            self.detail_delay_range = (detail_min, detail_max)
        if page_delay_range is not None:
            self.page_delay_range = page_delay_range
        else:
            page_min = _delay_seconds(
                collection_cfg.get("job51_page_delay_min_seconds"),
                PAGE_DELAY_MIN_SECONDS,
            )
            page_max = max(
                page_min,
                _delay_seconds(
                    collection_cfg.get("job51_page_delay_max_seconds"),
                    PAGE_DELAY_MAX_SECONDS,
                ),
            )
            self.page_delay_range = (page_min, page_max)

    @staticmethod
    def build_search_url(request: PlatformCollectionRequest, city: str, keyword: str) -> str:
        code = str(request.city_codes.get(city) or "").strip()
        if not code:
            raise CollectionError("no_valid_city", f"未配置 51job 城市编码：{city}")
        return SEARCH_URL.format(area=quote(code), keyword=quote(keyword))

    def _wait(self, hooks: CollectorHooks, seconds: float) -> bool:
        if hooks.stop_event is not None:
            return hooks.stop_event.wait(max(0.0, seconds))
        self.sleep(max(0.0, seconds))
        return False

    def collect(self, request: PlatformCollectionRequest, hooks: CollectorHooks) -> PlatformCollectionResult:
        detail_requests = 0
        for city in request.cities:
            if not request.city_codes.get(city):
                return PlatformCollectionResult(self.platform, "failed", "no_valid_city", f"51job 城市编码未配置：{city}")
            for keyword in request.keywords:
                search_url = self.build_search_url(request, city, keyword)
                initial_url = "about:blank" if self.browser.navigate_action is not None else search_url
                target_id = self.browser.new_tab(initial_url, background=True)
                if not target_id:
                    return PlatformCollectionResult(self.platform, "failed", "browser_disconnected", "无法打开 51job 搜索页")
                if self.browser.navigate_action is not None and not self.browser.navigate_action(target_id, search_url):
                    return PlatformCollectionResult(self.platform, "failed", "browser_disconnected", "51job 搜索页导航失败")
                try:
                    for page in range(1, request.max_pages + 1):
                        if hooks.stop_event is not None and hooks.stop_event.is_set():
                            return PlatformCollectionResult(self.platform, "stopped", "user_stopped", "用户已停止")
                        if page > 1:
                            delay = self.uniform(*self.page_delay_range)
                            hooks.on_event(phase="pacing", keyword=keyword, city=city, page=page, message=f"翻页安全间隔 {delay:.1f} 秒")
                            if self._wait(hooks, delay):
                                return PlatformCollectionResult(self.platform, "stopped", "user_stopped", "用户已停止")
                            if self.browser.evaluate(target_id, JS_CLICK_NEXT) is not True:
                                return PlatformCollectionResult(self.platform, "completed", "search_exhausted", "51job 已到最后一页")
                        hooks.on_event(phase="loading_list", keyword=keyword, city=city, page=page)
                        self.browser.wait_for_load(target_id, timeout=15)
                        self.browser.scroll(target_id, y=2200)
                        payload: dict[str, Any] = {}
                        status = "waiting"
                        for attempt in range(RENDER_POLL_ATTEMPTS):
                            payload = _payload(self.browser.evaluate(target_id, JS_EXTRACT_LIST))
                            status = str(payload.get("status") or "selector_changed")
                            if status != "waiting":
                                break
                            if attempt + 1 < RENDER_POLL_ATTEMPTS and self._wait(hooks, RENDER_POLL_INTERVAL_SECONDS):
                                return PlatformCollectionResult(self.platform, "stopped", "user_stopped", "用户已停止")
                        if status in {"blocked", "throttled"}:
                            return PlatformCollectionResult(self.platform, "blocked", "rate_limit", "51job 出现验证或限流信号，已停止整个平台任务")
                        if status == "waiting":
                            return PlatformCollectionResult(self.platform, "blocked", "render_timeout", "51job 列表未稳定渲染，已安全停止")
                        if status != "ready" or not isinstance(payload.get("jobs"), list):
                            return PlatformCollectionResult(self.platform, "blocked", "selector_changed", "51job 列表页结构与预期不一致")

                        for raw_item in payload["jobs"]:
                            candidate = self._candidate_from_list(raw_item, city, keyword)
                            if candidate is None or not hooks.on_list_candidate(candidate):
                                continue
                            if detail_requests:
                                delay = self.uniform(*self.detail_delay_range)
                                hooks.on_event(phase="pacing", keyword=keyword, city=city, page=page, message=f"详情页安全间隔 {delay:.1f} 秒")
                                if self._wait(hooks, delay):
                                    return PlatformCollectionResult(self.platform, "stopped", "user_stopped", "用户已停止")
                            hooks.on_event(phase="loading_detail", keyword=keyword, city=city, page=page)
                            detail_initial_url = "about:blank" if self.browser.navigate_action is not None else candidate.url
                            detail_target = self.browser.new_tab(detail_initial_url, background=True)
                            if not detail_target:
                                hooks.on_parse_failed("无法打开 51job 详情页")
                                continue
                            if self.browser.navigate_action is not None and not self.browser.navigate_action(detail_target, candidate.url):
                                self.browser.close_tab(detail_target)
                                hooks.on_parse_failed("51job 详情页导航失败")
                                continue
                            detail_requests += 1
                            try:
                                self.browser.wait_for_load(detail_target, timeout=15)
                                detail: dict[str, Any] = {}
                                detail_status = "selector_changed"
                                for attempt in range(RENDER_POLL_ATTEMPTS):
                                    detail = _payload(self.browser.evaluate(detail_target, JS_EXTRACT_DETAIL))
                                    detail_status = str(detail.get("status") or "selector_changed")
                                    if detail_status in {"ready", "blocked", "offline"}:
                                        break
                                    if attempt + 1 < RENDER_POLL_ATTEMPTS and self._wait(hooks, RENDER_POLL_INTERVAL_SECONDS):
                                        return PlatformCollectionResult(self.platform, "stopped", "user_stopped", "用户已停止")
                            finally:
                                self.browser.close_tab(detail_target)
                            if detail_status == "blocked":
                                return PlatformCollectionResult(self.platform, "blocked", "rate_limit", "51job 详情页出现验证或限流，已停止整个平台任务")
                            if detail_status == "offline":
                                hooks.on_parse_failed("51job 岗位已下线")
                                continue
                            if detail_status != "ready" or not str(detail.get("jd") or "").strip():
                                return PlatformCollectionResult(self.platform, "blocked", "selector_changed", "51job 详情页结构变化，已安全停止")
                            final = self._candidate_from_detail(detail, candidate)
                            if not hooks.on_candidate(final):
                                return PlatformCollectionResult(self.platform, "completed", "callback_stopped", "采集回调已停止")
                finally:
                    self.browser.close_tab(target_id)
        return PlatformCollectionResult(self.platform, "completed", "search_exhausted", "51job 搜索结果已采集完毕")

    @staticmethod
    def _detail_url(raw_url: str, source_job_id: str) -> str:
        """Return a real job-detail URL, ignoring company profile links."""
        candidate = str(raw_url or "").strip()
        if candidate.startswith("https://jobs.51job.com/") and not COMPANY_PAGE_RE.search(candidate):
            return candidate
        source_job_id = str(source_job_id or "").strip()
        if source_job_id.isdigit():
            return DETAIL_URL_TEMPLATE.format(job_id=source_job_id)
        return ""

    @staticmethod
    def _candidate_from_list(raw: Any, city: str, keyword: str) -> JobCandidate | None:
        if not isinstance(raw, dict):
            return None
        source_id = str(raw.get("source_job_id") or "").strip()
        title = str(raw.get("title") or "").strip()
        url = Job51Collector._detail_url(str(raw.get("url") or "").strip(), source_id)
        if not source_id or not title or not url:
            return None
        return JobCandidate(
            platform="51job",
            source_job_id=source_id,
            title=title,
            company=str(raw.get("company") or "").strip(),
            salary=str(raw.get("salary") or "").strip(),
            city=str(raw.get("city") or city).strip(),
            experience=str(raw.get("experience") or "").strip(),
            url=url,
            source_keyword=keyword,
        )

    @staticmethod
    def _clean_detail_title(value: object) -> str:
        title = str(value or "").replace("\u00a0", " ").strip()
        return DETAIL_TITLE_NOISE.sub("", title).strip()

    @staticmethod
    def _candidate_from_detail(detail: dict[str, Any], base: JobCandidate) -> JobCandidate:
        detail_title = Job51Collector._clean_detail_title(detail.get("title") or "")
        return JobCandidate(
            platform="51job",
            source_job_id=base.source_job_id,
            title=detail_title or base.title,
            company=str(detail.get("company") or base.company).strip(),
            salary=str(detail.get("salary") or base.salary).strip(),
            city=str(detail.get("city") or base.city).strip(),
            experience=base.experience,
            jd=str(detail.get("jd") or "").strip(),
            url=base.url,
            source_keyword=base.source_keyword,
        )
