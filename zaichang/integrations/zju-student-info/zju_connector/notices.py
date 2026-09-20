from __future__ import annotations

"""Read-only public Zhejiang University undergraduate notices.

The undergraduate teaching system exposes a public, paginated notice board.
This connector keeps only bounded metadata and a short plain-text excerpt from
the public notice body; it never stores the raw HTML response.
"""

import html
import json
import re
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlencode, urljoin, urlparse

from .http_client import CampusHttpClient


NOTICES_LIST_URL = "https://zdbk.zju.edu.cn/jwglxt/xtgl/xwck_cxMoreLoginNews.html"
NOTICES_PAGE_URL = "https://zdbk.zju.edu.cn/jwglxt/xtgl/xwck_cxMoreLoginNews.html"
NOTICE_DETAIL_PATH = "/jwglxt/xtgl/xwck_ckLoginNews.html"
OFFICIAL_HOST = "zdbk.zju.edu.cn"


def _clean_text(value: Any, limit: int | None = None) -> str:
    text = str(value or "")
    text = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", html.unescape(text)).strip()
    return text[:limit] if limit else text


def _official_url(value: Any, notice_id: str) -> str:
    candidate = str(value or "").strip()
    if not candidate:
        candidate = f"{NOTICE_DETAIL_PATH}?xwbh={notice_id}"
    url = urljoin(NOTICES_PAGE_URL, html.unescape(candidate))
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != OFFICIAL_HOST:
        return f"https://{OFFICIAL_HOST}{NOTICE_DETAIL_PATH}?xwbh={notice_id}"
    return url


class _NoticeContentParser(HTMLParser):
    """Collect visible text only inside the public notice content container."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        classes = set(str(attributes.get("class") or "").split())
        if self._depth == 0 and "news_con" in classes:
            self._depth = 1
        elif self._depth:
            self._depth += 1

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self._depth:
            self.parts.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if self._depth:
            self._depth -= 1

    def handle_data(self, data: str) -> None:
        if self._depth:
            self.parts.append(data)


def parse_notice_detail(detail_html: str, notice_url: str, limit: int = 6000) -> dict[str, Any]:
    """Extract a bounded text-only detail from an official notice page."""
    title_match = re.search(r"<h3\b[^>]*>([\s\S]*?)</h3>", detail_html, flags=re.I)
    meta_match = re.search(r"<h5\b[^>]*>([\s\S]*?)</h5>", detail_html, flags=re.I)
    meta = _clean_text(meta_match.group(1) if meta_match else "", 240)
    publisher_match = re.search(r"发布人\s*[：:]\s*([^\s]+)", meta)
    published_match = re.search(r"发布时间\s*[：:]\s*(20\d{2}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}:\d{2})", meta)
    parser = _NoticeContentParser()
    parser.feed(detail_html)
    content = _clean_text(" ".join(parser.parts), limit)
    if not content:
        # Keep a useful bounded fallback if the public site changes its class.
        content = _clean_text(detail_html, limit)
    return {
        "title": _clean_text(title_match.group(1) if title_match else "", 240),
        "publisher": publisher_match.group(1) if publisher_match else "",
        "publishedAt": published_match.group(1) if published_match else "",
        "detail": content,
        "detailSource": notice_url,
    }


def fetch_notice_detail(notice_url: str, client: CampusHttpClient | None = None) -> dict[str, Any]:
    parsed = urlparse(notice_url)
    if parsed.scheme != "https" or parsed.hostname != OFFICIAL_HOST:
        raise RuntimeError("通知详情链接不是浙大官方地址，已停止读取。")
    client = client or CampusHttpClient()
    status, body, _ = client.request(notice_url, timeout=15)
    if not 200 <= status < 300:
        raise RuntimeError(f"浙大通知详情暂时无法访问（HTTP {status}）。")
    return parse_notice_detail(body, notice_url)


def parse_public_notices(payload: str | dict[str, Any], source_url: str = NOTICES_LIST_URL, query: str | None = None) -> dict[str, Any]:
    """Normalize the public jqGrid response without retaining raw HTML."""
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError as error:
            raise RuntimeError("浙大通知公告接口返回了无法识别的数据。") from error
    if not isinstance(payload, dict):
        raise RuntimeError("浙大通知公告接口返回格式不正确。")
    raw_items = payload.get("items")
    if not isinstance(raw_items, list):
        raise RuntimeError("浙大通知公告接口没有返回通知列表。")

    notices: list[dict[str, Any]] = []
    for item in raw_items[:20]:
        if not isinstance(item, dict):
            continue
        notice_id = str(item.get("xwbh") or "").strip()
        title = _clean_text(item.get("xwbt"), 240)
        if not notice_id or not title:
            continue
        published_at = _clean_text(item.get("fbsj"), 40)
        publisher = _clean_text(item.get("xwfbr"), 120)
        summary = _clean_text(item.get("fbnr"), 360)
        notices.append(
            {
                "id": f"zju-notice-{notice_id.lower()}",
                "title": title,
                "publisher": publisher or "浙江大学本科生院",
                "publishedAt": published_at,
                "url": _official_url(item.get("fbdz"), notice_id),
                "summary": summary,
                "pinned": str(item.get("sfzd") or "") == "1",
                "source": source_url,
            }
        )
    notices.sort(key=lambda item: str(item.get("publishedAt") or ""), reverse=True)
    if query:
        needle = query.casefold().strip()
        notices = [
            notice for notice in notices
            if needle in " ".join(str(notice.get(key) or "") for key in ("title", "publisher", "summary")).casefold()
        ]
    total_count = payload.get("totalCount")
    total_available = int(total_count) if isinstance(total_count, (int, float)) and total_count >= 0 else len(notices)
    return {
        "notices": notices,
        "sources": [
            {
                "title": "浙江大学本科教学管理信息服务平台通知公告",
                "url": source_url,
                "kind": "official_notice_index",
            }
        ],
        "coverage": {
            "complete": bool(notices),
            "scope": "官方通知公告列表搜索结果",
            "total_available": total_available,
            "note": "只保留公开通知的标题、发布信息、官方详情链接和有界摘要；原始 HTML 不写入本机缓存。",
        },
    }


def fetch_public_notices(
    query: str | None = None,
    page: int = 1,
    include_details: bool = False,
    client: CampusHttpClient | None = None,
) -> dict[str, Any]:
    client = client or CampusHttpClient()
    page = max(1, min(50, int(page)))
    query = (query or "").strip()[:100] or None
    params = {
        "doType": "query",
        # The public page uses jqGrid's nested queryModel names.  The
        # shorter page/rows names are silently ignored by the server, which
        # makes every requested page look like page 1.
        "queryModel.currentPage": str(page),
        "queryModel.showCount": "10",
        "queryModel.sortName": "sfzd desc,fbsj",
        "queryModel.sortOrder": "desc",
        "xwbt": query or "",
    }
    url = f"{NOTICES_LIST_URL}?{urlencode(params)}"
    status, body, _ = client.request(url, timeout=15)
    if not 200 <= status < 300:
        raise RuntimeError(f"浙大官方通知公告暂时无法访问（HTTP {status}）。")
    normalized = parse_public_notices(body, NOTICES_LIST_URL, query=query)
    normalized["coverage"]["page"] = page
    normalized["coverage"]["query"] = query
    normalized["coverage"]["details_included"] = include_details
    if include_details:
        for notice in normalized["notices"][:3]:
            try:
                detail = fetch_notice_detail(str(notice["url"]), client)
            except Exception:
                continue
            if detail.get("detail"):
                notice["detail"] = detail["detail"]
                notice["detailSource"] = detail["detailSource"]
            if detail.get("title"):
                notice["title"] = detail["title"]
            if detail.get("publisher"):
                notice["publisher"] = detail["publisher"]
            if detail.get("publishedAt"):
                notice["publishedAt"] = detail["publishedAt"]
    return normalized
