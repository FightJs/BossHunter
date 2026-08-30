import unittest

from bosshunter.ai.prefilter import quick_score
from bosshunter.job_filters import matches_search_keyword, matching_blocked_company, parse_monthly_salary_k


class JobFilterTests(unittest.TestCase):
    def test_parse_common_monthly_salary_formats(self):
        self.assertEqual(parse_monthly_salary_k("10-15K"), (10.0, 15.0))
        self.assertEqual(parse_monthly_salary_k("8-13K·13薪"), (8.0, 13.0))
        self.assertEqual(parse_monthly_salary_k("12K"), (12.0, 12.0))
        self.assertEqual(parse_monthly_salary_k("8千-1万"), (8.0, 10.0))
        self.assertEqual(parse_monthly_salary_k("1-2万"), (10.0, 20.0))
        self.assertEqual(parse_monthly_salary_k("8000-12000元/月"), (8.0, 12.0))
        self.assertEqual(parse_monthly_salary_k("8000-11000元"), (8.0, 11.0))

    def test_unconvertible_salary_formats_are_not_parsed(self):
        self.assertIsNone(parse_monthly_salary_k("150-200元/天"))
        self.assertIsNone(parse_monthly_salary_k("薪资面议"))

    def test_blocked_company_matches_case_insensitive_substring(self):
        matched = matching_blocked_company("某公司科技有限公司", ["某公司"])

        self.assertEqual(matched, "某公司")

    def test_blocked_company_ignores_empty_rules(self):
        matched = matching_blocked_company("某公司科技有限公司", ["", "  "])

        self.assertIsNone(matched)

    def test_search_keyword_matches_title_or_jd_without_english_substring_false_positives(self):
        self.assertTrue(matches_search_keyword("AI Agent Engineer", "", "agent"))
        self.assertTrue(matches_search_keyword("产品经理", "负责智能体工作流开发", "智能体"))
        self.assertFalse(matches_search_keyword("Paid Media Specialist", "负责媒体投放", "ai"))
        self.assertFalse(matches_search_keyword("汽车展厅经理", "负责展厅运营", "agent"))

    def test_quick_score_filters_existing_job_by_company(self):
        score, reason = quick_score(
            {"title": "产品经理", "company": "某公司科技有限公司", "salary": "20-30K"},
            {"profile": {"blocked_companies": ["某公司"]}},
        )

        self.assertEqual(score, 0)
        self.assertIn("某公司", reason)

    def test_quick_score_filters_jobs_that_do_not_match_the_source_keyword(self):
        score, reason = quick_score(
            {
                "title": "汽车展厅经理",
                "jd": "负责客户接待和展厅运营",
                "salary": "8-11K",
                "source_keyword": "agent",
            },
            {"profile": {}},
        )

        self.assertEqual(score, 0)
        self.assertEqual(reason, "搜索关键词未命中: agent")


if __name__ == "__main__":
    unittest.main()
