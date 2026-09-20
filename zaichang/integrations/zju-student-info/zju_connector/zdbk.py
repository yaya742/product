from __future__ import annotations

import html
import re
from urllib.parse import quote, urlencode, urljoin

from .auth import AuthenticatedSession


ZDBK_HOME = "https://zdbk.zju.edu.cn/jwglxt/xtgl/index_initMenu.html"
ZDBK_SERVICE = "https://zdbk.zju.edu.cn/jwglxt/xtgl/login_ssologin.html"
SCHEDULE_URL = "https://zdbk.zju.edu.cn/jwglxt/kbcx/xskbcx_cxXsKb.html"
EXAMS_URL = "https://zdbk.zju.edu.cn/jwglxt/xskscx/kscx_cxXsgrksIndex.html?doType=query&queryModel.showCount=5000"
COURSES_HOME = "https://courses.zju.edu.cn/user/index"
TODOS_URL = "https://courses.zju.edu.cn/api/todos"


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


def _meta_refresh(body: str, source: str) -> str | None:
    for tag in re.findall(r"<meta\b[^>]*>", body, flags=re.IGNORECASE):
        if not re.search(r"http-equiv\s*=\s*[\"']?refresh", tag, flags=re.IGNORECASE):
            continue
        match = re.search(r"url\s*=\s*[\"']?([^\"' >;]+)", tag, flags=re.IGNORECASE)
        if match:
            return urljoin(source, html.unescape(match.group(1)))
    return None


def fetch_todos(session: AuthenticatedSession) -> list[dict]:
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
