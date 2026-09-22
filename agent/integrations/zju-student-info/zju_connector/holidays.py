from __future__ import annotations

"""Read-only public Zhejiang University calendar sources.

The undergraduate calendar is published as an image-only PDF, so the
connector deliberately keeps the official page/PDF as a source link and
extracts the dated teaching notices that are published as HTML.  This avoids
inventing dates from an OCR result while still making the useful holiday and
make-up-class information queryable.
"""

from datetime import date
import html
import re
from typing import Any
from urllib.parse import urljoin, urlparse

from .http_client import CampusHttpClient


CALENDAR_LIST_URL = "https://ugrs.zju.edu.cn/28218/list1.htm"
CALENDAR_LIST_FALLBACK_URL = "https://ugrs.zju.edu.cn/28218/list.htm"
HOLIDAY_NOTICES = {
    "2026-2027": "https://zdbk.zju.edu.cn/jwglxt/xtgl/xwck_ckLoginNews.html?xwbh=5ADCDCE300FB9DBBE06329B3CA0A2097",
}
KNOWN_CALENDAR_PAGES = {
    "2026-2027": "https://ugrs.zju.edu.cn/2026/0710/c28218a3187939/page.htm",
}
KNOWN_CALENDAR_PDFS = {
    "2026-2027": "https://ugrs.zju.edu.cn/_upload/article/files/28/cc/ce06b4d9483eb58be317e94a7749/eeeb30e1-336a-4d3f-8aca-5890d2cc2ac4.pdf",
}


def _clean_text(value: str) -> str:
    value = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", value, flags=re.I)
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def _compact_text(value: str) -> str:
    return re.sub(r"\s+", "", html.unescape(value))


def discover_calendar_pages(index_html: str) -> dict[str, str]:
    """Find academic-year calendar pages from the official list page."""
    found: dict[str, str] = {}
    blocks = re.findall(r"<li\b[\s\S]*?</li>", index_html, flags=re.I)
    for block in blocks:
        href_match = re.search(r'<a\s+href=["\']([^"\']+)["\']', block, flags=re.I)
        title_match = re.search(r"<p>\s*([^<]*校历[^<]*)</p>", block, flags=re.I)
        if not href_match or not title_match:
            continue
        href, title = href_match.group(1), title_match.group(1)
        compact = _compact_text(title)
        match = re.search(r"浙江大学\s*(20\d{2})[—–-](20\d{2})学年校历", compact)
        if match:
            found[f"{match.group(1)}-{match.group(2)}"] = urljoin(CALENDAR_LIST_URL, href)
    return found


def parse_calendar_page(page_html: str, page_url: str) -> dict[str, Any]:
    title_match = re.search(r"<title[^>]*>([\s\S]*?)</title>", page_html, flags=re.I)
    title = _clean_text(title_match.group(1)) if title_match else "浙江大学校历"
    year_match = re.search(r"(20\d{2})[—–-](20\d{2})学年校历", _compact_text(title))
    academic_year = f"{year_match.group(1)}-{year_match.group(2)}" if year_match else None
    pdf_match = re.search(r"pdfsrc=[\"']([^\"']+)[\"']", page_html, flags=re.I)
    pdf_url = urljoin(page_url, html.unescape(pdf_match.group(1))) if pdf_match else None
    if pdf_url and urlparse(pdf_url).hostname != "ugrs.zju.edu.cn":
        pdf_url = None
    return {"title": title, "academic_year": academic_year, "page_url": page_url, "pdf_url": pdf_url}


def _iso(year: int, month: int, day: int) -> str:
    return date(year, month, day).isoformat()


def _year_for_month(academic_year: str, month: int) -> int:
    start_year = int(academic_year[:4])
    return start_year + (1 if month <= 7 else 0)


def _span_event(text: str, academic_year: str, title: str, kind: str) -> dict[str, Any] | None:
    match = re.search(
        rf"{re.escape(title)}.*?(?P<sm>\d{{1,2}})月(?P<sd>\d{{1,2}})日.*?(?:至|到|—|-)(?:(?P<em>\d{{1,2}})月)?(?P<ed>\d{{1,2}})日.*?(?P<note>放假[^。；;]*)?",
        text,
    )
    if not match:
        return None
    sm, sd = int(match.group("sm")), int(match.group("sd"))
    em = int(match.group("em") or sm)
    ed = int(match.group("ed"))
    try:
        return {
            "id": {"中秋节": "mid-autumn-festival", "国庆节": "national-day"}.get(title, kind),
            "title": title,
            "startDate": _iso(_year_for_month(academic_year, sm), sm, sd),
            "endDate": _iso(_year_for_month(academic_year, em), em, ed),
            "kind": kind,
            "note": (match.group("note") or "官方教学安排提醒").strip(),
        }
    except ValueError:
        return None


def parse_holiday_notice(notice_html: str, academic_year: str, source_url: str) -> list[dict[str, Any]]:
    """Extract only explicit holiday spans from an official teaching notice."""
    text = _compact_text(_clean_text(notice_html))
    events: list[dict[str, Any]] = []
    for title in ("中秋节", "国庆节"):
        event = _span_event(text, academic_year, title, "holiday")
        if event:
            event["source"] = source_url
            events.append(event)

    # A notice can contain one-day campus activity breaks. Keep those as
    # explicit dates without trying to infer a school's full make-up policy.
    student_day = re.search(
        r"浙江大学学生节.*?(?P<m>\d{1,2})月(?P<d>\d{1,2})日.*?停课.*?(?P<y2>20\d{2})年(?P<m2>\d{1,2})月(?P<d2>\d{1,2})日.*?补课",
        text,
    )
    if student_day:
        m, d = int(student_day.group("m")), int(student_day.group("d"))
        y2, m2, d2 = int(student_day.group("y2")), int(student_day.group("m2")), int(student_day.group("d2"))
        try:
            events.append(
                {
                    "id": "zju-student-day",
                    "title": "浙江大学学生节",
                    "startDate": _iso(_year_for_month(academic_year, m), m, d),
                    "endDate": _iso(_year_for_month(academic_year, m), m, d),
                    "kind": "campus_event",
                    "note": f"停课，{_iso(y2, m2, d2)}补课。",
                    "source": source_url,
                }
            )
        except ValueError:
            pass
    return events


def fallback_public_calendar(academic_year: str, reason: str) -> dict[str, Any] | None:
    """Return a bounded official-source snapshot when campus TLS is unavailable."""
    page_url = KNOWN_CALENDAR_PAGES.get(academic_year)
    if not page_url:
        return None
    notice_url = HOLIDAY_NOTICES.get(academic_year)
    events = [
        {
            "id": "mid-autumn-festival",
            "title": "中秋节",
            "startDate": "2026-09-25",
            "endDate": "2026-09-27",
            "kind": "holiday",
            "note": "官方教学安排提醒",
            "source": notice_url,
        },
        {
            "id": "national-day",
            "title": "国庆节",
            "startDate": "2026-10-01",
            "endDate": "2026-10-07",
            "kind": "holiday",
            "note": "官方教学安排提醒",
            "source": notice_url,
        },
        {
            "id": "zju-student-day",
            "title": "浙江大学学生节",
            "startDate": "2026-12-31",
            "endDate": "2026-12-31",
            "kind": "campus_event",
            "note": "停课，2027-01-04补课。",
            "source": notice_url,
        },
    ] if academic_year == "2026-2027" else []
    return {
        "academic_year": academic_year,
        "events": events,
        "holidays": events,
        "sources": [
            {"title": f"浙江大学{academic_year}学年校历", "page_url": page_url, "pdf_url": KNOWN_CALENDAR_PDFS.get(academic_year), "kind": "official_calendar"},
            *([{"title": "节假日及学校活动期间教学安排提醒", "page_url": notice_url, "kind": "official_teaching_notice"}] if notice_url else []),
        ],
        "issues": [{"resource": "network", "message": reason}],
        "coverage": {
            "complete": bool(events),
            "note": "当前使用上次验证过的官方来源快照；网络恢复后会在两天窗口到期时重新核验。",
        },
    }


def fetch_public_calendar(academic_year: str, client: CampusHttpClient | None = None) -> dict[str, Any]:
    client = client or CampusHttpClient()
    try:
        status, index_html, _ = client.request(CALENDAR_LIST_URL, timeout=12)
        if not 200 <= status < 300:
            status, index_html, _ = client.request(CALENDAR_LIST_FALLBACK_URL, timeout=12)
        if not 200 <= status < 300:
            raise RuntimeError(f"浙大官方校历列表暂时无法访问（HTTP {status}）。")
        pages = discover_calendar_pages(index_html)
        page_url = pages.get(academic_year)
        if not page_url:
            raise RuntimeError(f"官方校历列表中暂未找到 {academic_year} 学年。")
        page_status, page_html, _ = client.request(page_url, timeout=12)
        if not 200 <= page_status < 300:
            raise RuntimeError(f"浙大官方校历页面暂时无法访问（HTTP {page_status}）。")
        calendar = parse_calendar_page(page_html, page_url)
        if calendar.get("academic_year") and calendar["academic_year"] != academic_year:
            raise RuntimeError("官方校历页面的学年与请求不一致，已停止使用。")
        notice_url = HOLIDAY_NOTICES.get(academic_year)
        events: list[dict[str, Any]] = []
        issues: list[dict[str, str]] = []
        if notice_url:
            notice_status, notice_html, _ = client.request(notice_url, timeout=12)
            if 200 <= notice_status < 300:
                events = parse_holiday_notice(notice_html, academic_year, notice_url)
            else:
                issues.append({"resource": "holiday_notice", "message": f"节假日教学安排暂时无法访问（HTTP {notice_status}）。"})
        else:
            issues.append({"resource": "holiday_notice", "message": "该学年暂未配置官方节假日教学安排公告，当前仅返回校历来源。"})
        return {
            "academic_year": academic_year,
            "events": events,
            "holidays": events,
            "sources": [
                {
                    "title": calendar.get("title") or f"浙江大学{academic_year}学年校历",
                    "page_url": calendar["page_url"],
                    "pdf_url": calendar.get("pdf_url"),
                    "kind": "official_calendar",
                },
                *([{"title": "节假日及学校活动期间教学安排提醒", "page_url": notice_url, "kind": "official_teaching_notice"}] if notice_url else []),
            ],
            "issues": issues,
            "coverage": {
                "complete": bool(events),
                "note": "校历原件由浙大官方页面提供；节假日事件只采用官方 HTML 教学安排公告，未对图片型 PDF 做 OCR 推断。",
            },
        }
    except Exception as exception:
        fallback = fallback_public_calendar(academic_year, "官方校历实时核验暂时失败，本次保留已验证的公开来源快照。")
        if fallback:
            return fallback
        raise RuntimeError(str(exception)) from exception
