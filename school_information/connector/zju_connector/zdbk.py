from __future__ import annotations

import html
import re
from urllib.parse import quote, urlencode, urljoin, urlparse

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
    payload, _headers = session.client.json(TODOS_URL)
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
    """Follow the learning-platform bootstrap redirect and verify its cookie."""
    current = COURSES_HOME
    for _ in range(5):
        status, body, _headers = session.client.request(current)
        if not 200 <= status < 300:
            raise RuntimeError(f"学在浙大登录失败（HTTP {status}）。")
        target = _meta_refresh(body, current)
        if not target:
            break
        current = target
    if not session.client.has_cookie("session", "courses.zju.edu.cn"):
        raise RuntimeError("学在浙大没有建立可用会话。")


def _payload_items(payload: object, keys: tuple[str, ...]) -> list[dict]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in keys:
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
        if isinstance(value, dict):
            nested = _payload_items(value, keys)
            if nested:
                return nested
    for value in payload.values():
        nested = _payload_items(value, keys)
        if nested:
            return nested
    return []


def _first(item: dict, *names: str):
    for name in names:
        value = item.get(name)
        if value not in (None, ""):
            return value
    return None


def _learning_course(item: dict) -> dict | None:
    course_id = _first(item, "id", "course_id", "courseId", "cid")
    name = _first(item, "name", "title", "course_name", "courseName")
    if course_id in (None, "") or name in (None, ""):
        return None
    result = {"id": str(course_id)[:100], "name": str(name)[:240]}
    for target, names in {
        "code": ("code", "course_code", "courseCode"),
        "teachers": ("teachers", "teacher", "instructor", "instructors"),
        "term": ("term", "semester", "semester_name", "semesterName"),
        "credit": ("credit", "credits"),
        "status": ("status", "course_status", "courseStatus"),
    }.items():
        value = _first(item, *names)
        if value not in (None, ""):
            result[target] = value
    return result


def fetch_learning_courses(session: AuthenticatedSession) -> list[dict]:
    ensure_courses_session(session)
    payload, _headers = session.client.json(MY_COURSES_URL)
    items = _payload_items(payload, ("courses", "course_list", "items", "data", "results"))
    courses = []
    seen: set[str] = set()
    for item in items:
        course = _learning_course(item)
        if course and course["id"] not in seen:
            seen.add(course["id"])
            courses.append(course)
    return courses[:500]


def _learning_activity(item: dict, course_id: str) -> dict | None:
    activity_id = _first(item, "id", "activity_id", "activityId", "aid")
    title = _first(item, "title", "name", "activity_name", "activityName")
    if activity_id in (None, "") or title in (None, ""):
        return None
    result = {"id": str(activity_id)[:100], "courseId": course_id, "title": str(title)[:240]}
    for target, names in {
        "type": ("type", "activity_type", "activityType"),
        "startTime": ("start_time", "startTime", "start_at", "startAt"),
        "endTime": ("end_time", "endTime", "end_at", "endAt"),
        "deadline": ("deadline", "due_time", "dueTime", "due_at", "dueAt"),
        "status": ("status", "state"),
        "url": ("url", "href", "link"),
    }.items():
        value = _first(item, *names)
        if value not in (None, ""):
            if target == "url":
                parsed = urlparse(str(value))
                host = (parsed.hostname or "").lower().rstrip(".")
                if parsed.scheme != "https" or not (host == "zju.edu.cn" or host.endswith(".zju.edu.cn")):
                    continue
                value = parsed.geturl()
            result[target] = value
    return result


def fetch_course_activities(session: AuthenticatedSession, course_id: str) -> list[dict]:
    course_id = str(course_id or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", course_id):
        raise RuntimeError("学在浙大课程编号格式不正确。")
    ensure_courses_session(session)
    payload, _headers = session.client.json(COURSE_ACTIVITIES_URL.format(course_id=quote(course_id, safe="")))
    items = _payload_items(payload, ("activities", "activity_list", "items", "data", "results"))
    activities = []
    seen: set[str] = set()
    for item in items:
        activity = _learning_activity(item, course_id)
        if activity and activity["id"] not in seen:
            seen.add(activity["id"])
            activities.append(activity)
    return activities[:500]


def fetch_learning(session: AuthenticatedSession, course_id: str | None = None, include_activities: bool = False) -> dict:
    courses = fetch_learning_courses(session)
    activities: list[dict] = []
    issues: list[dict[str, str]] = []
    selected = str(course_id or "") or None
    if selected and selected not in {course["id"] for course in courses}:
        raise RuntimeError("学在浙大没有找到对应课程。")
    if include_activities or selected:
        targets = [selected] if selected else [course["id"] for course in courses[:20]]
        for target in targets:
            try:
                activities.extend(fetch_course_activities(session, target))
            except Exception as exception:
                issues.append({"courseId": target, "message": str(exception)[:300]})
    return {
        "courses": courses,
        "activities": activities,
        "coverage": {
            "complete": not issues,
            "courseCount": len(courses),
            "activityCount": len(activities),
            "courseId": selected,
            "note": "默认只读取课程列表；需要课程活动时请指定 courseId 或 refreshActivities。",
        },
        "issues": issues,
    }
