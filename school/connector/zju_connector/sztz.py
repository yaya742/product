from __future__ import annotations

import base64
import html
import json
from urllib.parse import quote, urljoin, urlparse
from typing import Any

from .auth import AuthenticatedSession


SZTZ_SERVICE = "https://sztz.zju.edu.cn/dekt/"
SZTZ_CTX = "https://sztz.zju.edu.cn/dekt/ctx"
SZTZ_PROJECTS = "https://sztz.zju.edu.cn/dekt/student/home/getSqjl"
SZTZ_SUMMARY = "https://sztz.zju.edu.cn/dekt/student/home/getMyInfo"


def _text(value: Any, fallback: str = "") -> str:
    if value is None:
        return fallback
    text = str(value).strip()
    return text or fallback


def _number(value: Any) -> float | None:
    try:
        text = _text(value).replace(",", "")
        return float(text) if text else None
    except (TypeError, ValueError):
        return None


def _integer(value: Any) -> int | None:
    number = _number(value)
    return int(number) if number is not None and number.is_integer() else None


def _boolean(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if value == 1:
            return True
        if value == 0:
            return False
    normalized = _text(value).lower()
    if normalized in {"true", "1", "1.0", "yes", "y", "是", "通过", "已通过", "达标", "合格"}:
        return True
    if normalized in {"false", "0", "0.0", "no", "n", "否", "未通过", "不通过", "未达标", "不合格"}:
        return False
    return None


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _ctx_is_authenticated(body: str) -> bool:
    try:
        payload = json.loads(body)
        if not isinstance(payload, dict) or payload.get("success") is not True or int(payload.get("code", -1)) != 0:
            return False
        encoded = _text(payload.get("data"))
        if not encoded:
            return False
        decoded = base64.b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8")
        context = json.loads(decoded)
        if not isinstance(context, dict) or context.get("anonymous") is not False:
            return False
        user_id = _text(context.get("userId"))
        if not user_id or user_id.upper() == "ANONYMOUS":
            return False
        roles = json.dumps(context.get("roles"), ensure_ascii=False)
        return "ANONYMOUS_USER_ROLE" not in roles
    except (TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return False


def _header(headers: dict[str, str], name: str) -> str:
    target = name.lower()
    return next((value for key, value in headers.items() if key.lower() == target), "")


def _login_sztz(session: AuthenticatedSession) -> None:
    service_login = f"https://zjuam.zju.edu.cn/cas/login?service={quote(SZTZ_SERVICE, safe='')}"
    status, _body, headers = session.client.request(service_login, follow_redirects=False)
    location = _header(headers, "Location")
    if status < 300 or status >= 400 or not location:
        raise RuntimeError("素质拓展平台没有返回有效的统一认证跳转。")
    callback = urljoin(service_login, html.unescape(location))
    parsed = urlparse(callback)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "sztz.zju.edu.cn"
        or parsed.path.rstrip("/") != "/dekt"
        or not parsed.query
        or not parsed.query.lower().count("ticket=")
    ):
        raise RuntimeError("素质拓展平台返回了不受信任的认证回调。")
    status, _body, _headers = session.client.request(callback, follow_redirects=False)
    if status != 200 or not session.client.has_cookie("SESSION", "sztz.zju.edu.cn"):
        raise RuntimeError("素质拓展平台没有建立正式登录会话。")

    status, body, _headers = session.client.request(
        SZTZ_CTX,
        data=b"",
        headers={
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://sztz.zju.edu.cn",
            "Referer": SZTZ_SERVICE,
        },
        follow_redirects=False,
    )
    if status != 200 or not _ctx_is_authenticated(body):
        raise RuntimeError("素质拓展平台身份确认未完成。")


def _parse_project(raw: dict[str, Any], index: int) -> dict[str, Any] | None:
    item_id = _integer(raw.get("id"))
    if item_id is None:
        return None
    project = _mapping(raw.get("xm"))
    category = _mapping(project.get("xmfl"))
    project_type = _mapping(project.get("xmlb"))
    quality_type = _mapping(project.get("xmlx"))
    status = _mapping(raw.get("cyrshzt"))
    current_state = _mapping(raw.get("currentState"))
    category_id = _integer(category.get("id")) or 0
    category_name = _text(category.get("mc"), "未分类课堂")
    if not category_id:
        category_id = {"第二课堂": 1, "第三课堂": 2, "第四课堂": 3}.get(category_name, 0)
    if category_name == "未分类课堂":
        category_name = {1: "第二课堂", 2: "第三课堂", 3: "第四课堂"}.get(category_id, category_name)
    status_value = _integer(status.get("value"))
    status_label = _text(status.get("label")) or _text(current_state.get("name"), "状态未知")
    score = _number(raw.get("jd"))
    deleted = _boolean(raw.get("sfsc")) is True
    approved = status_value == 5 or status_label == "审核通过"
    return {
        "id": item_id,
        "categoryId": category_id,
        "categoryName": category_name,
        "projectName": _text(project.get("mc"), "未命名项目"),
        "projectType": _text(project_type.get("mc"), "未填写"),
        "qualityType": _text(quality_type.get("mc"), "未填写"),
        "score": score if score is not None and score >= 0 else None,
        "statusValue": status_value,
        "statusLabel": status_label,
        "approved": approved,
        "deleted": deleted,
        "countsTowardTotal": approved and not deleted and 1 <= category_id <= 3 and score is not None and score >= 0,
        "role": _text(raw.get("hdjjygrcdgz")) or None,
        "remark": _text(raw.get("qksm")) or None,
        "activityStart": _text(raw.get("hdsj")) or None,
        "activityEnd": _text(raw.get("hdjssj")) or None,
        "updatedAt": _text(raw.get("gxsj")) or None,
        "sourceIndex": index,
    }


def _parse_summary(raw: dict[str, Any]) -> dict[str, Any]:
    fields = ("dektJf", "dsktJf", "dsiktJf")
    if not any(field in raw for field in fields):
        raise RuntimeError("素质拓展汇总缺少课堂记点字段。")
    summary: dict[str, Any] = {
        field: _number(raw.get(field)) or 0
        for field in fields
    }
    for field in ("dektXf", "dsktXf", "dsiktXf", "dektDj", "dsktDj", "dsiktDj"):
        if field in raw:
            summary[field] = _number(raw.get(field))
    summary.update(
        {
            "dektTg": _boolean(raw.get("dektTg")),
            "dsktTg": _boolean(raw.get("dsktTg")),
            "dsiktTg": _boolean(raw.get("dsiktTg")),
            "myTg": _boolean(raw.get("myTg")),
            "lyTg": _boolean(raw.get("lyTg")),
            "summarySource": "sztz.getMyInfo",
            "summaryStale": False,
        }
    )
    return summary


def _calculated_summary(projects: list[dict[str, Any]]) -> dict[str, Any]:
    totals = {1: 0.0, 2: 0.0, 3: 0.0}
    for project in projects:
        category_id = project.get("categoryId")
        if project.get("countsTowardTotal") and category_id in totals:
            totals[category_id] += float(project.get("score") or 0)
    return {
        "dektJf": totals[1],
        "dsktJf": totals[2],
        "dsiktJf": totals[3],
        "myTg": None,
        "lyTg": None,
        "summarySource": "sztz.getSqjl-derived",
        "summaryStale": True,
    }


def fetch_practice(session: AuthenticatedSession, expected_student_id: str | None = None) -> dict[str, Any]:
    """Read Sztz summary and project details without retaining raw responses."""
    _login_sztz(session)
    issues: list[str] = []
    summary: dict[str, Any] | None = None
    projects: list[dict[str, Any]] = []

    try:
        status, body, _headers = session.client.request(
            SZTZ_SUMMARY,
            headers={"Accept": "application/json, text/plain, */*", "Referer": SZTZ_SERVICE},
            follow_redirects=False,
        )
        if status != 200:
            raise RuntimeError(f"素质拓展汇总请求失败（HTTP {status}）。")
        payload = json.loads(body)
        extend = _mapping(payload.get("extend")) if isinstance(payload, dict) else {}
        raw_summary = _mapping(extend.get("myInfo"))
        response_student_id = _text(raw_summary.get("xh"))
        if expected_student_id and response_student_id and response_student_id != expected_student_id:
            raise RuntimeError("素质拓展返回的账号与当前登录账号不一致。")
        summary = _parse_summary(raw_summary)
    except (RuntimeError, ValueError, TypeError, json.JSONDecodeError) as error:
        issues.append("汇总：" + (str(error) if isinstance(error, RuntimeError) else "返回格式无法识别。"))

    try:
        status, body, _headers = session.client.request(
            SZTZ_PROJECTS,
            headers={
                "Accept": "application/json, text/html, */*",
                "Referer": SZTZ_SERVICE,
            },
            follow_redirects=False,
        )
        if status != 200:
            raise RuntimeError(f"素质拓展项目请求失败（HTTP {status}）。")
        payload = json.loads(body)
        if not isinstance(payload, dict) or payload.get("success") is not True or int(payload.get("code", -1)) != 0:
            raise RuntimeError("素质拓展项目返回了未认证或无法识别的数据。")
        raw_items = payload.get("data")
        if not isinstance(raw_items, list):
            raise RuntimeError("素质拓展项目响应缺少项目列表。")
        seen: set[int] = set()
        for index, raw in enumerate(raw_items):
            if not isinstance(raw, dict):
                continue
            item = _parse_project(raw, index)
            if item is None or item["id"] in seen or item["deleted"]:
                continue
            seen.add(item["id"])
            item.pop("sourceIndex", None)
            projects.append(item)
    except (RuntimeError, ValueError, TypeError, json.JSONDecodeError) as error:
        issues.append("项目：" + (str(error) if isinstance(error, RuntimeError) else "返回格式无法识别。"))

    if summary is None and projects:
        summary = _calculated_summary(projects)
    if summary is None and not projects:
        raise RuntimeError(issues[0] if issues else "素质拓展没有返回可识别的数据。")

    return {
        "practice_summary": [summary],
        "projects": projects,
        "practice_projects": len(projects),
        "coverage": {
            "complete": not issues,
            "summary": summary is not None,
            "projects": not any(issue.startswith("项目：") for issue in issues),
            "note": "第二、三、四课堂记点与素质拓展项目分开保存；体育课成绩仍以教务网成绩记录为准。",
        },
        "issues": [{"resource": "practice", "message": issue} for issue in issues],
        "source": {"service": "ZJU 素质拓展平台", "evidence": "live authenticated read"},
    }
