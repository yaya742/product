from __future__ import annotations

from datetime import datetime
import re
from typing import Any


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _integer(value: Any, fallback: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def schedule_item(raw: dict[str, Any], semester_id: str, index: int) -> dict[str, Any] | None:
    if not raw.get("kcb") or _text(raw.get("sfyjskc")) == "1":
        return None
    parts = re.split(r"<br\s*/?>", _text(raw.get("kcb")), flags=re.IGNORECASE)
    parts = [re.sub(r"zwf.*$", "", part).strip() for part in parts]
    name = parts[0].replace("(", "（").replace(")", "）") if parts else "未知课程"
    teacher = parts[2] if len(parts) > 2 and parts[2] else "未知教师"
    location = parts[3] if len(parts) > 3 and parts[3] else None
    first = _integer(raw.get("djj"))
    duration = _integer(raw.get("skcd"))
    if first <= 0 or duration <= 0:
        return None
    season = _text(raw.get("xxq"))
    odd_even = _text(raw.get("dsz"))
    return {
        "uid": f"{semester_id}:class:{index}",
        "summary": name,
        "teacher": teacher,
        "location": location,
        "weekday": _integer(raw.get("xqj"), 1),
        "periods": list(range(first, first + duration)),
        "half": season or None,
        "weekPattern": "odd" if odd_even == "0" else "even" if odd_even == "1" else "all",
        "time_precision": "recurring_periods",
        "rescheduled": False,
    }


def courses_from_schedule(records: list[dict[str, Any]], semester_id: str) -> list[dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    for record in records:
        name = record["summary"]
        course = found.setdefault(
            name,
            {
                "key": f"{semester_id}:{len(found) + 1}",
                "name": name,
                "semester_id": semester_id,
                "teachers": [],
                "confirmed": True,
            },
        )
        teacher = record.get("teacher")
        if teacher and teacher not in course["teachers"]:
            course["teachers"].append(teacher)
    return list(found.values())


def _parse_exam_time(value: str) -> tuple[str | None, str | None, str | None]:
    label = value.strip() or None
    match = re.search(
        r"(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?[^\d]*(\d{1,2}):(\d{2})\s*[-~至]\s*(\d{1,2}):(\d{2})",
        value,
    )
    if not match:
        return None, None, label
    year, month, day, start_hour, start_minute, end_hour, end_minute = map(int, match.groups())
    start = datetime(year, month, day, start_hour, start_minute).astimezone().isoformat()
    end = datetime(year, month, day, end_hour, end_minute).astimezone().isoformat()
    return start, end, label


def exam_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for raw in items:
        course_id = _text(raw.get("xkkh"))
        name = _text(raw.get("kcmc")) or "未知课程"
        for exam_type, time_key, room_key, seat_key in (
            ("midterm", "qzkssj", "qzjsmc", "qzzwxh"),
            ("final", "kssj", "jsmc", "zwxh"),
        ):
            raw_time = _text(raw.get(time_key))
            if not raw_time:
                continue
            start, end, label = _parse_exam_time(raw_time)
            records.append(
                {
                    "id": f"{course_id}:{exam_type}",
                    "name": name.replace("(", "（").replace(")", "）"),
                    "type": exam_type,
                    "startTime": start,
                    "endTime": end,
                    "dateLabel": label,
                    "location": _text(raw.get(room_key)) or None,
                    "seat": _text(raw.get(seat_key)) or None,
                    "time_precision": "exact" if start and end else "source_label_only",
                }
            )
    return records

