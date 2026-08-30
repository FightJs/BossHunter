"""Shared job filtering helpers."""

import re


_MONTHLY_SALARY_UNIT = r"[kK万千]|元(?:\s*/\s*月)?"


def matching_deal_breaker(text: str, deal_breakers: list[str]) -> str | None:
    """Return the first deal-breaker keyword found in text."""
    text_lower = text.lower()
    for keyword in deal_breakers:
        cleaned_keyword = keyword.strip()
        if cleaned_keyword and cleaned_keyword.lower() in text_lower:
            return keyword
    return None


def matching_blocked_company(company: str, blocked_companies: list[str]) -> str | None:
    """Return the first blocked-company rule contained in a company name."""
    company_lower = str(company or "").strip().lower()
    for rule in blocked_companies or []:
        cleaned_rule = str(rule or "").strip()
        if cleaned_rule and cleaned_rule.lower() in company_lower:
            return cleaned_rule
    return None


def matches_search_keyword(title: str, jd: str, keyword: str) -> bool:
    """Return whether the source search keyword occurs in a job's title or JD."""
    cleaned_keyword = str(keyword or "").strip()
    if not cleaned_keyword:
        return True

    searchable = "\n".join((str(title or ""), str(jd or ""))).casefold()
    needle = cleaned_keyword.casefold()
    if re.fullmatch(r"[a-z0-9][a-z0-9 ._+#-]*", needle):
        return re.search(rf"(?<![a-z0-9]){re.escape(needle)}(?![a-z0-9])", searchable) is not None
    return needle in searchable


def parse_monthly_salary_k(salary: str) -> tuple[float, float] | None:
    """Parse common monthly salary labels into a comparable range in K."""
    normalized = str(salary or "").strip()
    # Daily/hourly wages must never be treated as monthly salary.
    if re.search(r"元\s*/\s*(?:天|日|小时|时)", normalized, re.IGNORECASE):
        return None

    range_match = re.search(
        rf"(\d+(?:\.\d+)?)\s*({_MONTHLY_SALARY_UNIT})?\s*[-至~～]\s*"
        rf"(\d+(?:\.\d+)?)\s*({_MONTHLY_SALARY_UNIT})?",
        normalized,
    )
    if range_match:
        low, low_unit, high, high_unit = range_match.groups()
        low_value = _salary_value_k(float(low), low_unit or high_unit)
        high_value = _salary_value_k(float(high), high_unit)
        if low_value is None or high_value is None:
            return None
        low, high = low_value, high_value
        return (min(low, high), max(low, high))

    single_match = re.search(
        rf"(\d+(?:\.\d+)?)\s*({_MONTHLY_SALARY_UNIT})(?!\w)",
        normalized,
    )
    if single_match:
        value = _salary_value_k(float(single_match.group(1)), single_match.group(2))
        if value is None:
            return None
        return value, value
    return None


def _salary_value_k(value: float, unit: str | None) -> float | None:
    """Convert a salary value with a recognized monthly unit to K."""
    normalized_unit = re.sub(r"\s+", "", str(unit or "")).lower()
    if normalized_unit in {"", "k"}:
        return value
    if normalized_unit == "万":
        return value * 10
    if normalized_unit == "千":
        return value
    if normalized_unit in {"元", "元/月"}:
        return value / 1000
    return None
