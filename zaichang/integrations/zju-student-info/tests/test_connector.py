import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
import sys

sys.path.insert(0, str(ROOT))

from zju_connector.auth import _encrypt_password
import zju_connector.cli as cli
from zju_connector.holidays import discover_calendar_pages, parse_calendar_page, parse_holiday_notice
from zju_connector.notices import fetch_public_notices, parse_notice_detail, parse_public_notices
from zju_connector.normalize import courses_from_schedule, exam_items, grade_alerts, grade_items, grade_semester_summaries, grade_summary, schedule_item


class ConnectorTests(unittest.TestCase):
    def test_password_rsa_operation_is_deterministic_without_logging_plaintext(self):
        encrypted = _encrypt_password("password", "ffffffffffffffffffffffffffffffff", "1")
        self.assertTrue(encrypted.endswith("70617373776f7264"))
        self.assertNotIn("password", encrypted)

    def test_schedule_is_normalized_to_recurrence_without_private_fields(self):
        record = schedule_item(
            {
                "kcb": "高等数学<br>教学班<br>张老师<br>紫金港东1-101zwf",
                "xqj": "2",
                "djj": "3",
                "skcd": "2",
                "dsz": "",
                "xxq": "秋冬",
                "xh": "private-student-number",
            },
            "2026-2027-1",
            0,
        )
        self.assertIsNotNone(record)
        self.assertEqual(record["summary"], "高等数学")
        self.assertEqual(record["periods"], [3, 4])
        self.assertNotIn("xh", record)
        self.assertEqual(courses_from_schedule([record], "2026-2027-1")[0]["name"], "高等数学")

    def test_exam_parser_keeps_source_label_when_exact_time_is_missing(self):
        records = exam_items([
            {"xkkh": "ABC", "kcmc": "课程", "kssj": "2026年6月20日 09:00-11:00", "jsmc": "教室", "zwxh": "12"},
            {"xkkh": "DEF", "kcmc": "课程2", "kssj": "待定", "jsmc": "", "zwxh": ""},
        ])
        self.assertEqual(records[0]["time_precision"], "exact")
        self.assertEqual(records[1]["time_precision"], "source_label_only")
        self.assertEqual(records[1]["dateLabel"], "待定")

    def test_grade_parser_and_summary_keep_source_score_and_bound_gpa_claim(self):
        records = grade_items([
            {"xkkh": "MATH-1", "kcmc": "高等数学", "xf": "4", "cj": "92", "jd": "4.0"},
            {"xkkh": "PE-1", "kcmc": "体育", "xf": "1", "cj": "通过", "jd": ""},
        ])
        self.assertEqual(records[0]["original"], "92")
        self.assertEqual(records[0]["fivePoint"], 4.0)
        self.assertTrue(records[0]["gpaIncluded"])
        self.assertFalse(records[1]["gpaIncluded"])
        summary = grade_summary(records)[0]
        self.assertEqual(summary["gpa"], 4.0)
        self.assertFalse(summary["complete"])
        self.assertIn("重修", summary["note"])

    def test_grade_semester_summary_only_uses_explicit_source_term(self):
        records = grade_items([
            {"xkkh": "A", "kcmc": "课程A", "xf": "2", "cj": "90", "jd": "4", "xnmmc": "2025-2026", "xqm": "1"},
            {"xkkh": "B", "kcmc": "课程B", "xf": "2", "cj": "88", "jd": "3.7"},
        ])
        self.assertEqual(records[0]["semester_id"], "2025-2026-1")
        summaries = grade_semester_summaries(records)
        self.assertEqual(len(summaries), 1)
        self.assertEqual(summaries[0]["semester_id"], "2025-2026-1")
        self.assertFalse(summaries[0]["complete"])

    def test_grade_alerts_are_bounded_and_not_school_policy(self):
        records = grade_items([
            {"xkkh": "A", "kcmc": "课程A", "xf": "2", "cj": "59", "jd": "1.5"},
            {"xkkh": "B", "kcmc": "课程B", "xf": "2", "cj": "68", "jd": "2.5"},
            {"xkkh": "C", "kcmc": "课程C", "xf": "2", "cj": "90", "jd": "4"},
        ])
        alerts = grade_alerts(records)
        self.assertEqual([item["level"] for item in alerts], ["failed", "attention"])
        self.assertTrue(all("不代表学校最终" in item["note"] for item in alerts))

    def test_public_calendar_parser_keeps_official_sources_and_explicit_dates(self):
        index = '''<li><a href="/2026/0710/c28218a3187939/page.htm"><p>浙江大学2026—2027学年校历</p></a></li>'''
        page = '''<title>浙江大学2026—2027学年校历</title><div pdfsrc="/_upload/calendar.pdf"></div>'''
        notice = '''<h3>本科生院关于2026年下半年部分节假日教学安排</h3>
        <p>一、中秋节 9月25日（周五）至27日（周日）放假，共3天。</p>
        <p>二、国庆节 10月1日（周四）至7日（周三）放假调休，共7天。</p>
        <p>三、浙江大学学生节 学校于12月31日举办。12月31日停课，安排在2027年1月4日补课。</p>'''
        pages = discover_calendar_pages(index)
        self.assertEqual(pages["2026-2027"], "https://ugrs.zju.edu.cn/2026/0710/c28218a3187939/page.htm")
        calendar = parse_calendar_page(page, pages["2026-2027"])
        self.assertEqual(calendar["pdf_url"], "https://ugrs.zju.edu.cn/_upload/calendar.pdf")
        events = parse_holiday_notice(notice, "2026-2027", "https://zdbk.zju.edu.cn/notice")
        self.assertEqual([(event["title"], event["startDate"], event["endDate"]) for event in events[:2]], [
            ("中秋节", "2026-09-25", "2026-09-27"),
            ("国庆节", "2026-10-01", "2026-10-07"),
        ])
        self.assertEqual(events[2]["note"], "停课，2027-01-04补课。")

    def test_academic_sync_keeps_schedule_when_another_resource_has_a_network_error(self):
        raw_schedule = [{
            "kcb": "高等数学<br>教学班<br>张老师<br>紫金港东1-101",
            "xqj": "2",
            "djj": "3",
            "skcd": "2",
            "dsz": "",
            "xxq": "秋冬",
        }]
        with patch.object(cli, "authenticate", return_value=object()), \
             patch.object(cli, "load_credentials", return_value=object()), \
             patch.object(cli, "history", return_value=[]), \
             patch.object(cli, "fetch_schedule", return_value=raw_schedule), \
             patch.object(cli, "fetch_exams", return_value=[]), \
             patch.object(cli, "fetch_grades", return_value=[]), \
             patch.object(cli, "fetch_todos", side_effect=OSError("TLS detail must not leak")), \
             patch.object(cli, "save_academic_bundle", return_value="bundle-test"):
            result = cli._academic("2026-2027", "1")
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["bundle_id"], "bundle-test")
        self.assertEqual(result["counts"]["classes"], 1)
        self.assertEqual(result["issues"][0]["resource"], "todos")
        self.assertNotIn("TLS detail", result["issues"][0]["message"])

    def test_academic_sync_preserves_previous_section_when_schedule_refresh_fails(self):
        previous = {
            "classes": [{"uid": "old-class", "summary": "历史课程"}],
            "courses": [{"key": "old-course", "name": "历史课程"}],
            "exams": [{"id": "old-exam", "name": "历史考试"}],
            "todos": [{"id": "old-todo", "name": "历史待办"}],
        }
        with patch.object(cli, "authenticate", return_value=object()), \
             patch.object(cli, "load_credentials", return_value=object()), \
             patch.object(cli, "history", return_value=[{"kind": "academic", "semester_id": "2026-2027-1", "bundle_id": "a" * 32}]), \
             patch.object(cli, "load_bundle", return_value={"normalized": previous}), \
             patch.object(cli, "fetch_schedule", side_effect=OSError("temporary schedule outage")), \
             patch.object(cli, "fetch_exams", return_value=[]), \
             patch.object(cli, "fetch_grades", return_value=[]), \
             patch.object(cli, "fetch_todos", return_value=[]), \
             patch.object(cli, "save_academic_bundle", return_value="bundle-new"):
            result = cli._academic("2026-2027", "1")
        self.assertEqual(result["status"], "partial")
        self.assertIn("classes", result["preserved_resources"])
        self.assertIn("courses", result["preserved_resources"])
        self.assertEqual(result["counts"]["classes"], 1)
        self.assertEqual(result["counts"]["exams"], 0)

    def test_calendar_sync_saves_public_snapshot_without_credentials(self):
        normalized = {
            "academic_year": "2026-2027",
            "events": [{"id": "national-day", "title": "国庆节", "startDate": "2026-10-01", "endDate": "2026-10-07"}],
            "holidays": [{"id": "national-day", "title": "国庆节", "startDate": "2026-10-01", "endDate": "2026-10-07"}],
            "sources": [{"kind": "official_calendar", "page_url": "https://ugrs.zju.edu.cn/calendar"}],
            "issues": [],
            "coverage": {"complete": True},
        }
        with patch.object(cli, "history", return_value=[]), \
             patch.object(cli, "fetch_public_calendar", return_value=normalized), \
             patch.object(cli, "save_calendar_bundle", return_value="b" * 32):
            result = cli._calendar("2026-2027", refresh=True)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["bundle_id"], "b" * 32)
        self.assertEqual(result["normalized"]["holidays"][0]["title"], "国庆节")

    def test_public_notices_parser_keeps_bounded_official_metadata(self):
        payload = {
            "totalCount": 2,
            "items": [
                {
                    "xwbh": "ABC123",
                    "xwbt": "关于秋学期选课的通知",
                    "xwfbr": "本科生院",
                    "fbsj": "2026-09-20 09:30:50",
                    "sfzd": "1",
                    "fbnr": "<p>各位同学，请按时登录系统。</p>" * 100,
                },
                {
                    "xwbh": "DEF456",
                    "xwbt": "关于考试安排的通知",
                    "xwfbr": "教务处",
                    "fbsj": "2026-09-19 08:00:00",
                    "sfzd": "0",
                    "fbnr": "<script>alert(1)</script><p>请查看详情。</p>",
                    "fbdz": "https://evil.example/notices/1",
                },
            ],
        }
        normalized = parse_public_notices(payload)
        self.assertEqual([record["title"] for record in normalized["notices"]], ["关于秋学期选课的通知", "关于考试安排的通知"])
        self.assertLessEqual(len(normalized["notices"][0]["summary"]), 360)
        self.assertNotIn("alert", normalized["notices"][1]["summary"])
        self.assertTrue(normalized["notices"][1]["url"].startswith("https://zdbk.zju.edu.cn/"))

    def test_public_notice_detail_parser_extracts_only_official_content(self):
        detail = '''<h3>关于选课的通知</h3><h5><span>发布人：本科生院</span><span>发布时间：2026-09-20 09:00:00</span></h5>
        <div class="news_con"><p>第一段正文。</p><div><table><tr><td>时间</td><td>9月20日</td></tr></table></div></div>
        <div class="footer">页面导航不应进入正文。</div>'''
        parsed = parse_notice_detail(detail, "https://zdbk.zju.edu.cn/jwglxt/xtgl/xwck_ckLoginNews.html?xwbh=ABC")
        self.assertEqual(parsed["title"], "关于选课的通知")
        self.assertEqual(parsed["publisher"], "本科生院")
        self.assertIn("第一段正文", parsed["detail"])
        self.assertIn("9月20日", parsed["detail"])
        self.assertNotIn("页面导航", parsed["detail"])

    def test_public_notice_fetch_uses_server_pagination_contract(self):
        class FakeClient:
            def __init__(self):
                self.url = ""

            def request(self, url, **kwargs):
                self.url = url
                return 200, json.dumps({"totalCount": 21, "items": []}), {}

        client = FakeClient()
        fetch_public_notices(query="选课", page=2, client=client)
        from urllib.parse import parse_qs, urlparse

        params = parse_qs(urlparse(client.url).query)
        self.assertEqual(params["queryModel.currentPage"], ["2"])
        self.assertEqual(params["queryModel.showCount"], ["10"])
        self.assertEqual(params["xwbt"], ["选课"])

    def test_notices_sync_saves_public_snapshot_without_credentials(self):
        normalized = {
            "notices": [{"id": "zju-notice-1", "title": "通知", "url": "https://zdbk.zju.edu.cn/notice"}],
            "sources": [{"kind": "official_notice_index", "url": "https://zdbk.zju.edu.cn/list"}],
            "coverage": {"complete": True},
        }
        with patch.object(cli, "history", return_value=[]), \
             patch.object(cli, "fetch_public_notices", return_value=normalized) as fetch, \
             patch.object(cli, "save_notices_bundle", return_value="c" * 32):
            result = cli._notices(refresh=True, query="选课", page=2, detail=True)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["bundle_id"], "c" * 32)
        self.assertEqual(result["normalized"]["notices"][0]["title"], "通知")
        fetch.assert_called_once_with(query="选课", page=2, include_details=True)


if __name__ == "__main__":
    unittest.main()
