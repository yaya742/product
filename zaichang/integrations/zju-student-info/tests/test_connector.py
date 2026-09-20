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
from zju_connector.normalize import courses_from_schedule, exam_items, schedule_item


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
             patch.object(cli, "fetch_todos", return_value=[]), \
             patch.object(cli, "save_academic_bundle", return_value="bundle-new"):
            result = cli._academic("2026-2027", "1")
        self.assertEqual(result["status"], "partial")
        self.assertIn("classes", result["preserved_resources"])
        self.assertIn("courses", result["preserved_resources"])
        self.assertEqual(result["counts"]["classes"], 1)
        self.assertEqual(result["counts"]["exams"], 0)


if __name__ == "__main__":
    unittest.main()
