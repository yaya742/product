from __future__ import annotations

"""Read bounded notices from official ZJU college websites."""

import hashlib
import html
import re
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlparse

from .http_client import CampusHttpClient


COLLEGE_DIRECTORY_URL = "https://www.zju.edu.cn/599/listm.htm"
OFFICIAL_SUFFIX = ".zju.edu.cn"
DATE_RE = re.compile(r"20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}")
SKIP_TITLES = {
    "首页",
    "学院首页",
    "学院概况",
    "学院简介",
    "联系我们",
    "网站首页",
    "站内搜索",
    "更多",
    "下一页",
    "上一页",
}
LIST_HINTS = ("通知", "公告", "本科", "学生", "教学", "招生", "新闻", "动态", "公示")
COLLEGE_BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
ALIASES = {
    "数院": "数学科学学院",
    "物院": "物理学院",
    "信电学院": "信息与电子工程学院",
    "信院": "信息与电子工程学院",
    "计院": "计算机科学与技术学院",
    "电气学院": "电气工程学院",
    "建工": "建筑工程学院",
    "化工": "化学工程与生物工程学院",
}


def _clean(value: Any, limit: int | None = None) -> str:
    text = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", str(value or ""), flags=re.I)
    text = re.sub(r"<[^>]+>", " ", html.unescape(text))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit] if limit else text


def _key(value: str) -> str:
    value = ALIASES.get(value.strip(), value)
    return re.sub(r"浙江大学|官方网站|官网|学院|科学|学校|大学|系", "", value).casefold()


def _official_url(value: str, base: str = COLLEGE_DIRECTORY_URL) -> str | None:
    raw = html.unescape(str(value or "").strip())
    if not raw or raw.startswith(("#", "javascript:", "mailto:")):
        return None
    url = urljoin(base, raw)
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme not in {"http", "https"} or not (host == "zju.edu.cn" or host.endswith(OFFICIAL_SUFFIX)):
        return None
    return parsed._replace(scheme="https").geturl()


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str]] = []
        self._href = ""
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "a":
            if self._href:
                self._flush()
            self._href = str(dict(attrs).get("href") or "")
            self._parts = []

    def handle_data(self, data: str) -> None:
        if self._href:
            self._parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "a" and self._href:
            self._flush()

    def close(self) -> None:
        if self._href:
            self._flush()
        super().close()

    def _flush(self) -> None:
        self.links.append((self._href, _clean(" ".join(self._parts), 240)))
        self._href = ""
        self._parts = []


def _links(body: str) -> list[tuple[str, str]]:
    parser = _LinkParser()
    parser.feed(body)
    parser.close()
    return parser.links


def _request(client: CampusHttpClient, url: str, *, timeout: float = 15, attempts: int = 2) -> str:
    # Several college sites reject or stall on connector-identifying user agents;
    # use a normal browser identity for this public, read-only HTML fetch.
    last_error: Exception | None = None
    for _ in range(max(1, attempts)):
        try:
            status, body, _ = client.request(url, headers={"User-Agent": COLLEGE_BROWSER_UA}, timeout=timeout)
            if not 200 <= status < 300:
                raise RuntimeError(f"浙大学院官网暂时无法访问（HTTP {status}）。")
            return body
        except Exception as error:
            last_error = error
    raise last_error or RuntimeError("浙大学院官网暂时无法访问。")


def _resolve_college(college: str, client: CampusHttpClient) -> tuple[str, str]:
    requested = college.strip()[:80]
    if not requested:
        raise ValueError("请提供要查询的学院名称，例如“数学学院”或“物理学院”。")
    body = _request(client, COLLEGE_DIRECTORY_URL)
    needle = _key(requested)
    candidates: list[tuple[int, str, str]] = []
    for href, title in _links(body):
        url = _official_url(href)
        if not url or not title or title in SKIP_TITLES:
            continue
        candidate = _key(title)
        if not candidate or not needle or (needle not in candidate and candidate not in needle):
            continue
        score = 0 if candidate == needle else 1
        candidates.append((score, title, url))
    if not candidates:
        raise ValueError(f"浙江大学官方学院目录中没有匹配“{requested}”的学院网站。")
    _, title, url = sorted(candidates, key=lambda item: (item[0], len(item[1])))[0]
    return title, url


def _discover_pages(home_url: str, body: str) -> list[str]:
    home_host = (urlparse(home_url).hostname or "").lower()
    ranked: list[tuple[int, str]] = []
    for href, title in _links(body):
        url = _official_url(href, home_url)
        if not url or url == home_url or not title:
            continue
        parsed = urlparse(url)
        if (parsed.hostname or "").lower() != home_host:
            continue
        lower = f"{title} {parsed.path}".casefold()
        score = sum(3 for hint in LIST_HINTS if hint in lower)
        if score:
            ranked.append((-score, url))
    pages = [home_url]
    for _, url in sorted(ranked):
        if url not in pages:
            pages.append(url)
        # Keep the common query bounded: homepage plus the most likely notice
        # page keeps a college lookup responsive on heterogeneous sites.
        if len(pages) >= 2:
            break
    return pages


def _notice_records(body: str, page_url: str, college: str, query: str | None) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    needle = query.casefold().strip() if query else ""
    for href, title in _links(body):
        url = _official_url(href, page_url)
        title = _clean(title, 240)
        if not url or not title or len(title) < 4 or title in SKIP_TITLES:
            continue
        if title.startswith(("---", "--")) or title.casefold() in {"more", "read more"}:
            continue
        if url in seen:
            continue
        if needle and needle not in title.casefold():
            continue
        seen.add(url)
        published = DATE_RE.search(title)
        digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:20]
        records.append(
            {
                "id": f"zju-college-notice-{digest}",
                "title": title,
                "publisher": college,
                "publishedAt": published.group(0).replace("/", "-") if published else "",
                "url": url,
                "summary": title,
                "pinned": False,
                "source": page_url,
            }
        )
    return records


def _detail(body: str, notice_url: str) -> dict[str, str]:
    text = _clean(body, 6000)
    return {"detail": text, "detailSource": notice_url} if text else {}


def fetch_college_notices(
    college: str,
    query: str | None = None,
    page: int = 1,
    include_details: bool = False,
    client: CampusHttpClient | None = None,
) -> dict[str, Any]:
    client = client or CampusHttpClient(allow_official_subdomains=True)
    page = max(1, min(20, int(page)))
    query = (query or "").strip()[:100] or None
    resolved_name, home_url = _resolve_college(college, client)
    home_body = _request(client, home_url)
    pages = _discover_pages(home_url, home_body)
    all_records: list[dict[str, Any]] = []
    fetched_pages = [home_url]
    for page_url in pages:
        if page_url == home_url:
            body = home_body
        else:
            try:
                body = _request(client, page_url, timeout=8, attempts=1)
            except Exception:
                # College sites are independently maintained; one unavailable
                # column must not erase notices already read from other pages.
                continue
            fetched_pages.append(page_url)
        all_records.extend(_notice_records(body, page_url, resolved_name, query))
        if len(all_records) >= 80:
            break
    unique: dict[str, dict[str, Any]] = {}
    for record in all_records:
        unique.setdefault(record["url"], record)
    records = list(unique.values())
    records.sort(key=lambda item: (str(item.get("publishedAt") or ""), str(item.get("title") or "")), reverse=True)
    total_available = len(records)
    start = (page - 1) * 10
    records = records[start : start + 10]
    if include_details:
        for record in records[:3]:
            try:
                detail = _detail(_request(client, record["url"]), record["url"])
            except Exception:
                continue
            record.update(detail)
    return {
        "notices": records,
        "sources": [
            {"title": "浙江大学学院（系）官方目录", "url": COLLEGE_DIRECTORY_URL, "kind": "official_college_directory"},
            *[{"title": f"{resolved_name}官方页面", "url": url, "kind": "official_college_notice_page"} for url in fetched_pages],
        ],
        "coverage": {
            "complete": bool(records),
            "scope": f"{resolved_name}官方站点信息",
            "college": resolved_name,
            "college_home": home_url,
            "page": page,
            "query": query,
            "total_available": total_available,
            "details_included": include_details,
            "note": "信息来自浙江大学学院官方站点；学院网站栏目结构可能不同，结果保留官方页面链接供核对。",
        },
    }
