from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import re
import sys
from typing import Any

from .auth import authenticate
from .credentials import forget_credentials, load_credentials, show_credentials_dialog
from .normalize import courses_from_schedule, exam_items, grade_alerts, grade_items, grade_semester_summaries, grade_summary, schedule_item
from .holidays import fetch_public_calendar
from .notices import fetch_public_notices
from .storage import forget_bundles, history, load_bundle, save_academic_bundle, save_calendar_bundle, save_notices_bundle
from .zdbk import fetch_exams, fetch_grades, fetch_schedule, fetch_todos


SUPPORTED_RESOURCES = {
    "classes",
    "courses",
    "exams",
    "todos",
    "grades",
    "grade_alerts",
    "gpa_overall",
    "gpa_semesters",
    "gpa_cumulative",
    "holidays",
    "notices",
    "source_status",
}


def _resource_issue(resource: str, exception: Exception) -> dict[str, str]:
    # RuntimeError messages are connector-authored and safe to show. Network
    # exceptions can contain implementation details, so keep those bounded.
    message = str(exception).strip() if isinstance(exception, RuntimeError) else "该校园资料暂时无法访问，本次仍会保留其他已读取的校园资料。"
    return {"resource": resource, "message": message or "该校园资料暂时无法访问，本次仍会保留其他已读取的校园资料。"}


def _previous_academic_bundle(semester_id: str) -> dict[str, Any] | None:
    """Return the last complete-enough snapshot without touching the network."""
    for item in history(100):
        if item.get("kind") != "academic" or str(item.get("semester_id") or "") != semester_id:
            continue
        bundle_id = item.get("bundle_id")
        if not isinstance(bundle_id, str):
            continue
        try:
            bundle = load_bundle(bundle_id)
        except (FileNotFoundError, OSError, ValueError):
            continue
        normalized = bundle.get("normalized")
        if isinstance(normalized, dict):
            return normalized
    return None


def emit(value: dict[str, Any]) -> int:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0 if value.get("status") in {"ok", "partial"} else 2


def error(code: str, message: str) -> int:
    return emit({"status": "error", "error": {"code": code, "message": message}})


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="zju.py", add_help=True)
    commands = parser.add_subparsers(dest="command", required=True)
    credentials = commands.add_parser("credentials")
    credentials.add_argument("action", choices=["set", "forget"])
    commands.add_parser("auth")
    academic = commands.add_parser("academic")
    academic.add_argument("--year", required=True)
    academic.add_argument("--term", choices=["1", "2"], required=True)
    calendar = commands.add_parser("calendar")
    calendar.add_argument("--year", required=True)
    calendar.add_argument("--refresh", action="store_true")
    notices = commands.add_parser("notices")
    notices.add_argument("--refresh", action="store_true")
    history_parser = commands.add_parser("history")
    history_parser.add_argument("--limit", type=int, default=20)
    quick = commands.add_parser("quick")
    quick.add_argument("resource")
    quick.add_argument("--bundle")
    quick.add_argument("--endpoint")
    quick.add_argument("--window")
    quick.add_argument("--from", dest="from_time")
    quick.add_argument("--to", dest="to_time")
    quick.add_argument("--at")
    quick.add_argument("--time-mode")
    quick.add_argument("--fields")
    quick.add_argument("--filter", action="append", default=[])
    quick.add_argument("--query")
    quick.add_argument("--sort")
    quick.add_argument("--limit", type=int, default=8)
    quick.add_argument("--offset", type=int, default=0)
    quick.add_argument("--refresh", action="store_true")
    return parser


def _previous_calendar_bundle(academic_year: str) -> tuple[str, dict[str, Any], str] | None:
    for item in history(100):
        if item.get("kind") != "calendar" or str(item.get("academic_year") or "") != academic_year:
            continue
        bundle_id = item.get("bundle_id")
        if not isinstance(bundle_id, str):
            continue
        try:
            bundle = load_bundle(bundle_id)
        except (FileNotFoundError, OSError, ValueError):
            continue
        normalized = bundle.get("normalized")
        fetched_at = bundle.get("fetched_at")
        if isinstance(normalized, dict) and isinstance(fetched_at, str):
            return bundle_id, normalized, fetched_at
    return None


def _calendar(academic_year: str, refresh: bool = False) -> dict[str, Any]:
    if not re.match(r"^20\d{2}-20\d{2}$", academic_year):
        return {"status": "error", "error": {"code": "INVALID_TERM", "message": "学年格式应为 2026-2027。"}}
    previous = _previous_calendar_bundle(academic_year)
    now = datetime.now(timezone.utc)
    if previous and not refresh:
        bundle_id, normalized, fetched_at = previous
        try:
            age_ms = max(0, (now - datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))).total_seconds() * 1000)
        except ValueError:
            age_ms = 49 * 60 * 60 * 1000
        if age_ms < 48 * 60 * 60 * 1000:
            return {
                "status": "ok" if normalized.get("coverage", {}).get("complete") else "partial",
                "bundle_id": bundle_id,
                "academic_year": academic_year,
                "fetched_at": fetched_at,
                "normalized": normalized,
                "stale": False,
                "source": {"service": "ZJU official public calendar", "evidence": "encrypted normalized cache"},
            }
        # A stale public calendar is still useful for the foreground question;
        # the desktop adapter will refresh it in the background.
        return {
            "status": "ok" if normalized.get("coverage", {}).get("complete") else "partial",
            "bundle_id": bundle_id,
            "academic_year": academic_year,
            "fetched_at": fetched_at,
            "normalized": normalized,
            "stale": True,
            "source": {"service": "ZJU official public calendar", "evidence": "encrypted normalized cache"},
        }
    try:
        normalized = fetch_public_calendar(academic_year)
        bundle_id = save_calendar_bundle(academic_year, normalized)
        return {
            "status": "ok" if normalized.get("coverage", {}).get("complete") else "partial",
            "bundle_id": bundle_id,
            "academic_year": academic_year,
            "fetched_at": now.isoformat(),
            "normalized": normalized,
            "stale": False,
            "source": {"service": "ZJU official public calendar", "evidence": "live public read"},
        }
    except Exception as exception:
        if previous:
            bundle_id, normalized, fetched_at = previous
            return {
                "status": "partial",
                "bundle_id": bundle_id,
                "academic_year": academic_year,
                "fetched_at": fetched_at,
                "normalized": normalized,
                "stale": True,
                "issues": [{"resource": "calendar", "message": _resource_issue("calendar", exception)["message"]}],
                "source": {"service": "ZJU official public calendar", "evidence": "previous encrypted cache"},
            }
        return {"status": "error", "error": {"code": "CALENDAR_SYNC_FAILED", "message": _resource_issue("calendar", exception)["message"]}}


def _previous_notices_bundle() -> tuple[str, dict[str, Any], str] | None:
    for item in history(100):
        if item.get("kind") != "notices":
            continue
        bundle_id = item.get("bundle_id")
        if not isinstance(bundle_id, str):
            continue
        try:
            bundle = load_bundle(bundle_id)
        except (FileNotFoundError, OSError, ValueError):
            continue
        normalized = bundle.get("normalized")
        fetched_at = bundle.get("fetched_at")
        if isinstance(normalized, dict) and isinstance(fetched_at, str):
            return bundle_id, normalized, fetched_at
    return None


def _notices(refresh: bool = False) -> dict[str, Any]:
    previous = _previous_notices_bundle()
    now = datetime.now(timezone.utc)
    if previous and not refresh:
        bundle_id, normalized, fetched_at = previous
        try:
            age_ms = max(0, (now - datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))).total_seconds() * 1000)
        except ValueError:
            age_ms = 49 * 60 * 60 * 1000
        return {
            "status": "ok" if normalized.get("coverage", {}).get("complete") else "partial",
            "bundle_id": bundle_id,
            "fetched_at": fetched_at,
            "normalized": normalized,
            "stale": age_ms >= 48 * 60 * 60 * 1000,
            "source": {"service": "ZJU official undergraduate notice board", "evidence": "encrypted normalized cache"},
        }
    try:
        normalized = fetch_public_notices()
        bundle_id = save_notices_bundle(normalized)
        return {
            "status": "ok" if normalized.get("coverage", {}).get("complete") else "partial",
            "bundle_id": bundle_id,
            "fetched_at": now.isoformat(),
            "normalized": normalized,
            "stale": False,
            "source": {"service": "ZJU official undergraduate notice board", "evidence": "live public read"},
        }
    except Exception as exception:
        if previous:
            bundle_id, normalized, fetched_at = previous
            return {
                "status": "partial",
                "bundle_id": bundle_id,
                "fetched_at": fetched_at,
                "normalized": normalized,
                "stale": True,
                "issues": [{"resource": "notices", "message": _resource_issue("notices", exception)["message"]}],
                "source": {"service": "ZJU official undergraduate notice board", "evidence": "previous encrypted cache"},
            }
        return {"status": "error", "error": {"code": "NOTICES_SYNC_FAILED", "message": _resource_issue("notices", exception)["message"]}}


def _academic(year: str, term: str) -> dict[str, Any]:
    if not year.startswith("20") or len(year) != 9 or year[4] != "-":
        return {"status": "error", "error": {"code": "INVALID_TERM", "message": "学年格式应为 2026-2027。"}}
    session = authenticate(load_credentials())
    semester_id = f"{year}-{term}"
    previous = _previous_academic_bundle(semester_id)
    issues: list[dict[str, str]] = []
    raw_schedule: list[dict] = []
    raw_exams: list[dict] = []
    raw_grades: list[dict] = []
    todos: list[dict] = []
    try:
        raw_schedule = fetch_schedule(session, year, term)
    except Exception as exception:
        issues.append(_resource_issue("classes", exception))
    try:
        raw_exams = fetch_exams(session)
    except Exception as exception:
        issues.append(_resource_issue("exams", exception))
    try:
        raw_grades = fetch_grades(session)
    except Exception as exception:
        issues.append(_resource_issue("grades", exception))
    try:
        todos = fetch_todos(session)
    except Exception as exception:
        issues.append(_resource_issue("todos", exception))
    classes = [record for index, raw in enumerate(raw_schedule) if (record := schedule_item(raw, semester_id, index))]
    grades = grade_items(raw_grades)
    alerts = grade_alerts(grades)
    gpa = grade_summary(grades)
    gpa_semesters = grade_semester_summaries(grades)
    normalized = {
        "classes": classes,
        "courses": courses_from_schedule(classes, semester_id),
        "exams": exam_items(raw_exams),
        "grades": grades,
        "grade_alerts": alerts,
        "gpa_overall": gpa,
        "gpa_semesters": gpa_semesters,
        "gpa_cumulative": gpa,
        "todos": todos,
        "source_status": [
            {"name": "教务网课表", "status": "ok" if not any(i["resource"] == "classes" for i in issues) else "failed"},
            {"name": "教务网考试", "status": "ok" if not any(i["resource"] == "exams" for i in issues) else "failed"},
            {"name": "教务网成绩", "status": "ok" if not any(i["resource"] == "grades" for i in issues) else "failed"},
            {"name": "学在浙大待办", "status": "ok" if not any(i["resource"] == "todos" for i in issues) else "failed"},
        ],
    }
    # A transient endpoint failure must never replace a known-good section with
    # an empty list. Keep the previous encrypted snapshot for only the failed
    # resource, while still reporting the issue and its source status.
    preserved_resources: list[str] = []
    failed_resources = {issue["resource"] for issue in issues}
    if previous:
        if "classes" in failed_resources and previous.get("classes"):
            normalized["classes"] = previous["classes"]
            normalized["courses"] = previous.get("courses", normalized["courses"])
            preserved_resources.extend(["classes", "courses"])
        if "exams" in failed_resources and previous.get("exams"):
            normalized["exams"] = previous["exams"]
            preserved_resources.append("exams")
        if "grades" in failed_resources and previous.get("grades"):
            normalized["grades"] = previous["grades"]
            normalized["grade_alerts"] = previous.get("grade_alerts", normalized["grade_alerts"])
            normalized["gpa_overall"] = previous.get("gpa_overall", normalized["gpa_overall"])
            normalized["gpa_semesters"] = previous.get("gpa_semesters", normalized["gpa_semesters"])
            normalized["gpa_cumulative"] = previous.get("gpa_cumulative", normalized["gpa_cumulative"])
            preserved_resources.extend(["grades", "grade_alerts", "gpa_overall", "gpa_semesters", "gpa_cumulative"])
        if "todos" in failed_resources and previous.get("todos"):
            normalized["todos"] = previous["todos"]
            preserved_resources.append("todos")
    if not any(normalized[key] for key in ("classes", "courses", "exams", "grades", "todos")) and issues:
        return {"status": "error", "error": {"code": "ACADEMIC_SYNC_FAILED", "message": issues[0]["message"]}}
    bundle_id = save_academic_bundle(semester_id, normalized)
    return {
        "status": "partial" if issues else "ok",
        "bundle_id": bundle_id,
        "semester_id": semester_id,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "counts": {key: len(value) for key, value in normalized.items()},
        "issues": issues,
        "preserved_resources": preserved_resources,
        "source": {"service": "ZJU local compatibility connector", "evidence": "live authenticated read"},
        "raw_data_preserved": False,
    }


def _quick(args: argparse.Namespace) -> dict[str, Any]:
    resource = args.resource
    if resource not in SUPPORTED_RESOURCES:
        return {
            "status": "partial",
            "resource": resource,
            "records": [],
            "coverage": {"complete": False, "scope": "not implemented in PC compatibility connector v0.1"},
            "error": {"code": "RESOURCE_NOT_SUPPORTED", "message": "这一类校园资料尚未在 PC 兼容连接中接入。"},
        }
    if not args.bundle:
        return {"status": "error", "error": {"code": "DATASET_REQUIRED", "message": "请先同步当前学期的校园资料。"}}
    bundle = load_bundle(args.bundle)
    normalized = bundle.get("normalized", {})
    records = normalized.get(resource)
    if resource == "holidays" and not isinstance(records, list):
        records = normalized.get("events", [])
    if not isinstance(records, list):
        records = []
    if resource == "notices" and args.query:
        query = args.query.casefold().strip()
        records = [
            record for record in records
            if isinstance(record, dict)
            and query in " ".join(str(record.get(key) or "") for key in ("title", "publisher", "summary")).casefold()
        ]
    offset = max(0, args.offset)
    limit = max(1, min(50, args.limit))
    selected = records[offset : offset + limit]
    if args.fields:
        fields = {field for field in args.fields.split(",") if field}
        selected = [{key: value for key, value in record.items() if key in fields} for record in selected if isinstance(record, dict)]
    exact_dates = resource != "classes" or all(record.get("startTime") for record in selected)
    complete = exact_dates
    note = None if exact_dates else "课表当前保留星期与节次，尚未把校历和调停课展开为逐次日期。"
    if resource in {"gpa_overall", "gpa_cumulative", "gpa_semesters"}:
        complete = bool(selected and selected[0].get("complete"))
        note = selected[0].get("note") if selected else "当前没有可用的成绩汇总。"
    if resource == "grade_alerts":
        complete = resource in normalized and isinstance(normalized.get("grades"), list)
        note = (
            "提示由已读取的成绩记录推导，不代表学校最终的补考、重修或学籍认定。"
            if complete
            else "当前缓存尚未生成成绩风险提示，请刷新一次校园资料。"
        )
    if resource == "holidays":
        complete = bool(normalized.get("coverage", {}).get("complete"))
        note = normalized.get("coverage", {}).get("note") or (
            "当前只读到官方校历来源，尚未读到对应的节假日教学安排公告。"
            if not complete
            else None
        )
    if resource == "notices":
        complete = bool(normalized.get("coverage", {}).get("complete"))
        note = normalized.get("coverage", {}).get("note") or (
            "当前没有读到浙大官方通知公告。" if not complete else None
        )
    return {
        "status": "ok" if complete else "partial",
        "resource": resource,
        "records": selected,
        "total_matches": len(records),
        "offset": offset,
        "next_offset": offset + limit if offset + limit < len(records) else None,
        "fetched_at": bundle.get("fetched_at"),
        "coverage": {
            "complete": complete,
            "scope": bundle.get("semester_id") or bundle.get("academic_year"),
            "note": note,
        },
        "source": {"service": "ZJU local compatibility connector", "evidence": "encrypted normalized cache"},
        "schema_version": 1,
    }


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
        if args.command == "credentials":
            if args.action == "set":
                return 0 if show_credentials_dialog() else 2
            forget_credentials()
            return emit({"status": "ok", "forgotten": True, "bundles_removed": forget_bundles()})
        if args.command == "auth":
            authenticate(load_credentials())
            return emit({"status": "ok", "authenticated_at": datetime.now(timezone.utc).isoformat(), "sso": True})
        if args.command == "academic":
            return emit(_academic(args.year, args.term))
        if args.command == "calendar":
            return emit(_calendar(args.year, args.refresh))
        if args.command == "notices":
            return emit(_notices(args.refresh))
        if args.command == "history":
            return emit({"status": "ok", "items": history(args.limit)})
        if args.command == "quick":
            return emit(_quick(args))
        return error("UNKNOWN_COMMAND", "不支持的连接器命令。")
    except FileNotFoundError:
        return error("AUTH_REQUIRED", "请先在 PC 端保存浙大统一身份认证信息。")
    except (RuntimeError, ValueError) as exception:
        return error("CONNECTOR_ERROR", str(exception))
    except Exception:
        return error("INTERNAL_ERROR", "校园连接器遇到未预期错误；没有输出账号或校园资料。")
