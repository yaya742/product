from __future__ import annotations

"""Read-only public Zhejiang University undergraduate notices.

The undergraduate teaching system exposes a public, paginated notice board.
This connector keeps only bounded metadata and a short plain-text excerpt from
the public notice body; it never stores the raw HTML response.
"""

import html
import json
import re
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


def parse_public_notices(payload: str | dict[str, Any], source_url: str = NOTICES_LIST_URL) -> dict[str, Any]:
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
            "scope": "官方通知公告列表最新一页",
            "total_available": total_available,
            "note": "只保留公开通知的标题、发布信息、官方详情链接和有界摘要；原始 HTML 不写入本机缓存。",
        },
    }


def fetch_public_notices(client: CampusHttpClient | None = None) -> dict[str, Any]:
    client = client or CampusHttpClient()
    params = {
        "doType": "query",
        "page": "1",
        "rows": "10",
        "sidx": "sfzd desc,fbsj",
        "sord": "desc",
        "xwbt": "",
    }
    url = f"{NOTICES_LIST_URL}?{urlencode(params)}"
    status, body, _ = client.request(url, timeout=15)
    if not 200 <= status < 300:
        raise RuntimeError(f"浙大官方通知公告暂时无法访问（HTTP {status}）。")
    return parse_public_notices(body, NOTICES_LIST_URL)
