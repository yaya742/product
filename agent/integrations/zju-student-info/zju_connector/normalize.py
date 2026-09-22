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


def _decimal(value: Any) -> float | None:
    try:
        text = _text(value).replace(",", "")
        return float(text) if text else None
    except (TypeError, ValueError):
        return None


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


def grade_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalize ZDBK grade rows without retaining raw response fields."""
    records: list[dict[str, Any]] = []
    for index, raw in enumerate(items):
        course_key = _text(raw.get("xkkh"))
        name = _text(raw.get("kcmc")) or "未知课程"
        credit = _decimal(raw.get("xf"))
        original = _text(raw.get("cj")) or None
        five_point = _decimal(raw.get("jd"))
        semester_id = _grade_semester_id(raw)
        if not course_key and not original and name == "未知课程":
            continue
        included = five_point is not None and credit is not None and credit > 0
        records.append(
            {
                "id": course_key or f"grade:{index}",
                "name": name.replace("(", "（").replace(")", "）"),
                "semester_id": semester_id,
                "course_key": course_key or None,
                "credit": credit,
                "original": original,
                "fivePoint": five_point,
                "gpaIncluded": included,
                "gpa_exclusion_reason": None if included else "成绩接口未提供可纳入绩点计算的学分或绩点。",
            }
        )
    return records


def _grade_semester_id(raw: dict[str, Any]) -> str | None:
    """Best-effort semester extraction; unknown source fields stay private."""
    direct = (
        raw.get("semester_id"),
        raw.get("semester"),
        raw.get("xq_id"),
    )
    for value in direct:
        text = _text(value)
        if text and ("-" in text or "学期" in text or "秋" in text or "春" in text):
            return text
    year = _text(raw.get("academic_year") or raw.get("xnmmc") or raw.get("xnm"))
    term = _text(raw.get("term") or raw.get("xqm") or raw.get("xqmmc"))
    if not year or not term:
        return None
    if re.fullmatch(r"20\d{2}-20\d{2}", year):
        term_code = {"1": "1", "3": "1", "秋冬": "1", "2": "2", "12": "2", "春夏": "2"}.get(term, term)
        return f"{year}-{term_code}"
    return f"{year}-{term}"


def grade_summary(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Compute a bounded aggregate while stating the missing school-side rules."""
    counted = [
        record
        for record in records
        if record.get("gpaIncluded") and isinstance(record.get("credit"), (int, float)) and isinstance(record.get("fivePoint"), (int, float))
    ]
    denominator = sum(float(record["credit"]) for record in counted)
    gpa = sum(float(record["credit"]) * float(record["fivePoint"]) for record in counted) / denominator if denominator else None
    return [
        {
            "through_semester": "all_available",
            "gpa": round(gpa, 3) if gpa is not None else None,
            "gpa_credit_denominator": round(denominator, 3),
            "eligible_attempts": len(records),
            "counted_attempts": len(counted),
            "excluded_attempts": len(records) - len(counted),
            "complete": False,
            "note": "教务成绩接口当前未返回重修取舍和学期排除口径；这里仅按可用成绩、绩点和学分计算近似汇总，不替代学校最终绩点。",
        }
    ] if records else []


def grade_semester_summaries(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return grouped summaries only when the source actually supplies terms."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        semester_id = _text(record.get("semester_id"))
        if semester_id:
            groups.setdefault(semester_id, []).append(record)
    summaries: list[dict[str, Any]] = []
    for semester_id in sorted(groups):
        summary = grade_summary(groups[semester_id])
        if summary:
            summaries.append({"semester_id": semester_id, **summary[0]})
    return summaries


def grade_alerts(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Surface objective low-score signals without claiming school policy."""
    alerts: list[dict[str, Any]] = []
    for record in records:
        original = _text(record.get("original"))
        numeric = _decimal(original)
        failed = (numeric is not None and numeric < 60) or bool(re.search(r"不及格|不通过|挂科|未通过", original))
        attention = (numeric is not None and 60 <= numeric < 70) or (
            not failed and isinstance(record.get("fivePoint"), (int, float)) and float(record["fivePoint"]) < 3
        )
        if not failed and not attention:
            continue
        alerts.append({
            "id": record.get("id"),
            "course_key": record.get("course_key"),
            "name": record.get("name"),
            "credit": record.get("credit"),
            "original": original or None,
            "fivePoint": record.get("fivePoint"),
            "level": "failed" if failed else "attention",
            "note": "按成绩原值/绩点做的提示，不代表学校最终的补考、重修或学籍认定。",
        })
    return alerts


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
