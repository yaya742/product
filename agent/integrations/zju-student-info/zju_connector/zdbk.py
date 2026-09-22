from __future__ import annotations

import html
import re
from urllib.parse import quote, urlencode, urljoin

from .auth import AuthenticatedSession


ZDBK_HOME = "https://zdbk.zju.edu.cn/jwglxt/xtgl/index_initMenu.html"
ZDBK_SERVICE = "https://zdbk.zju.edu.cn/jwglxt/xtgl/login_ssologin.html"
SCHEDULE_URL = "https://zdbk.zju.edu.cn/jwglxt/kbcx/xskbcx_cxXsKb.html"
EXAMS_URL = "https://zdbk.zju.edu.cn/jwglxt/xskscx/kscx_cxXsgrksIndex.html?doType=query&queryModel.showCount=5000"
GRADES_URL = "https://zdbk.zju.edu.cn/jwglxt/cxdy/xscjcx_cxXscjIndex.html?doType=query&queryModel.showCount=5000"
COURSES_HOME = "https://courses.zju.edu.cn/user/index"
TODOS_URL = "https://courses.zju.edu.cn/api/todos"
MY_COURSES_URL = "https://courses.zju.edu.cn/api/my-courses"
COURSE_ACTIVITIES_URL = "https://courses.zju.edu.cn/api/courses/{course_id}/activities"


def _ajax_headers() -> dict[str, str]:
    return {
        "Referer": ZDBK_HOME,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    }


def _courses_headers() -> dict[str, str]:
    return {
        "Referer": COURSES_HOME,
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
    }


def _payload_list(payload: object, keys: tuple[str, ...]) -> list[dict]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in keys:
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
        if isinstance(value, dict):
            nested = _payload_list(value, keys)
            if nested:
                return nested
    for key in ("data", "result", "response"):
        value = payload.get(key)
        if isinstance(value, dict):
            nested = _payload_list(value, keys)
            if nested:
                return nested
    return []


def _text(item: dict, *keys: str, default: str = "") -> str:
    for key in keys:
        value = item.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return default


def _course_record(item: dict, index: int) -> dict | None:
    course_id = _text(item, "id", "course_id", "courseId")
    if not course_id:
        return None
    return {
        "id": course_id,
        "name": _text(item, "name", "title", "course_name", "courseName", default="未命名课程"),
        "course_code": _text(item, "course_code", "courseCode", "code", "course_no") or None,
        "credit": item.get("credit", item.get("credits")),
        "semester_id": _text(item, "semester_id", "semesterId", "semester", "term_name", "termName") or None,
        "start_date": _text(item, "start_date", "startDate", "start_time", "startTime") or None,
        "end_date": _text(item, "end_date", "endDate", "end_time", "endTime") or None,
        "study_completeness": item.get("study_completeness", item.get("completion", item.get("progress"))),
    }


def _activity_record(item: dict, course_id: str, index: int) -> dict:
    activity_id = _text(item, "id", "activity_id", "activityId", default=f"{course_id}:activity:{index}")
    return {
        "activity_id": activity_id,
        "course_id": course_id,
        "name": _text(item, "title", "name", "activity_name", "activityName", default="未命名活动"),
        "type": _text(item, "type", "activity_type", "activityType", default="unknown"),
        "starts_at": _text(item, "start_time", "startTime", "starts_at", "startAt") or None,
        "deadline": _text(item, "end_time", "endTime", "deadline", "due_date", "dueDate") or None,
        "scores": item.get("scores", item.get("score")),
        "completion": item.get("completion", item.get("completed", item.get("status"))),
    }


def login_zdbk(session: AuthenticatedSession) -> None:
    service_login = f"https://zjuam.zju.edu.cn/cas/login?service={quote(ZDBK_SERVICE, safe='')}"
    status, body, _headers = session.client.request(service_login)
    if not 200 <= status < 400:
        raise RuntimeError(f"教务网登录失败（HTTP {status}）。")
    if not session.client.has_cookie("JSESSIONID", "zdbk.zju.edu.cn"):
        raise RuntimeError("教务网没有建立可用会话。")
    if "统一身份认证" in body and "name=\"execution\"" in body:
        raise RuntimeError("教务网登录态未建立，请重新验证账号。")


def fetch_schedule(session: AuthenticatedSession, academic_year: str, term: str) -> list[dict]:
    login_zdbk(session)
    seasons = ["1|秋", "1|冬"] if term == "1" else ["2|春", "2|夏"]
    records: list[dict] = []
    for season in seasons:
        encoded = urlencode({"xnm": academic_year, "xqm": season, "captcha_value": ""}).encode("utf-8")
        status, body, _headers = session.client.request(SCHEDULE_URL, data=encoded, headers=_ajax_headers())
        if status in (401, 403) or "统一身份认证" in body:
            raise RuntimeError("教务网登录态已失效。")
        if "captcha_error" in body:
            raise RuntimeError("教务网本次要求验证码；当前 PC 连接器不会绕过验证码。")
        if body.strip() == "null":
            continue
        try:
            import json

            payload = json.loads(body)
        except ValueError as error:
            raise RuntimeError("教务网课表返回了无法识别的数据。") from error
        items = payload.get("kbList")
        if not isinstance(items, list):
            raise RuntimeError("教务网课表响应缺少课程列表。")
        records.extend(item for item in items if isinstance(item, dict))
    return records


def fetch_exams(session: AuthenticatedSession) -> list[dict]:
    login_zdbk(session)
    status, body, _headers = session.client.request(EXAMS_URL, data=b"", headers=_ajax_headers())
    if status in (401, 403) or "统一身份认证" in body:
        raise RuntimeError("教务网登录态已失效。")
    try:
        import json

        payload = json.loads(body)
    except ValueError as error:
        raise RuntimeError("教务网考试安排返回了无法识别的数据。") from error
    items = payload.get("items")
    if not isinstance(items, list):
        raise RuntimeError("教务网考试响应缺少考试列表。")
    return [item for item in items if isinstance(item, dict)]


def fetch_grades(session: AuthenticatedSession) -> list[dict]:
    """Read the authenticated student's grade records from the academic system."""
    login_zdbk(session)
    payload, _headers = session.client.json(GRADES_URL, data=b"", headers=_ajax_headers())
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        raise RuntimeError("教务网成绩响应缺少成绩列表。")
    return [item for item in items if isinstance(item, dict)]


def _meta_refresh(body: str, source: str) -> str | None:
    for tag in re.findall(r"<meta\b[^>]*>", body, flags=re.IGNORECASE):
        if not re.search(r"http-equiv\s*=\s*[\"']?refresh", tag, flags=re.IGNORECASE):
            continue
        match = re.search(r"url\s*=\s*[\"']?([^\"' >;]+)", tag, flags=re.IGNORECASE)
        if match:
            return urljoin(source, html.unescape(match.group(1)))
    return None


def fetch_todos(session: AuthenticatedSession) -> list[dict]:
    ensure_courses_session(session)
    payload, _headers = session.client.json(TODOS_URL, headers=_courses_headers())
    todos = payload.get("todo_list") if isinstance(payload, dict) else None
    if not isinstance(todos, list):
        raise RuntimeError("学在浙大响应缺少待办列表。")
    return [
        {
            "id": str(item.get("id", "")),
            "name": str(item.get("title", "未命名作业")),
            "course": str(item.get("course_name", "未知课程")),
            "deadline": item.get("end_time"),
            "status": "pending",
        }
        for item in todos
        if isinstance(item, dict) and item.get("is_student") in (True, 1, "1") and item.get("id")
    ]


def ensure_courses_session(session: AuthenticatedSession) -> None:
    """Exchange the already authenticated ZJU SSO cookie for a courses session."""
    current = COURSES_HOME
    for _ in range(8):
        status, body, _headers = session.client.request(current)
        if not 200 <= status < 300:
            raise RuntimeError(f"学在浙大登录失败（HTTP {status}）。")
        target = _meta_refresh(body, current)
        if not target:
            break
        current = target
    if not session.client.has_cookie("session", "courses.zju.edu.cn"):
        raise RuntimeError("学在浙大没有建立可用会话，请重新验证浙大账号。")
    if "统一身份认证" in body and ("name=\"username\"" in body or "name='username'" in body):
        raise RuntimeError("学在浙大登录态未建立，请重新验证浙大账号。")


def fetch_learning_courses(session: AuthenticatedSession) -> list[dict]:
    ensure_courses_session(session)
    from urllib.parse import urlencode

    query = urlencode({"page": 1, "page_size": 1000, "sort": "all"})
    payload, _headers = session.client.json(f"{MY_COURSES_URL}?{query}", headers=_courses_headers())
    records = []
    for index, item in enumerate(_payload_list(payload, ("courses", "items", "records", "list"))):
        record = _course_record(item, index)
        if record:
            records.append(record)
    if not records and isinstance(payload, dict) and any(key in payload for key in ("courses", "items", "records", "list")):
        return []
    if not records:
        raise RuntimeError("学在浙大课程接口返回了无法识别的数据。")
    return records


def fetch_course_activities(session: AuthenticatedSession, course_id: str) -> list[dict]:
    ensure_courses_session(session)
    safe_id = quote(str(course_id).strip(), safe="")
    if not safe_id or len(safe_id) > 80:
        raise RuntimeError("学在浙大课程编号不合法。")
    payload, _headers = session.client.json(
        COURSE_ACTIVITIES_URL.format(course_id=safe_id),
        headers=_courses_headers(),
    )
    items = _payload_list(payload, ("activities", "items", "records", "list"))
    return [_activity_record(item, str(course_id), index) for index, item in enumerate(items)]


def fetch_learning(session: AuthenticatedSession, course_id: str | None = None) -> dict:
    records = fetch_learning_courses(session)
    activities = fetch_course_activities(session, course_id) if course_id else []
    return {
        "records": records,
        "activities": activities,
        "course_id": course_id,
        "coverage": {"complete": True, "course_list": True, "activities": bool(course_id)},
    }
