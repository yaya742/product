from __future__ import annotations

import http.cookiejar
import json
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import (
    HTTPCookieProcessor,
    HTTPRedirectHandler,
    Request,
    build_opener,
)


ALLOWED_HOSTS = {
    "zjuam.zju.edu.cn",
    "identity.zju.edu.cn",
    "zdbk.zju.edu.cn",
    "courses.zju.edu.cn",
    "ugrs.zju.edu.cn",
    "sztz.zju.edu.cn",
}
USER_AGENT = "Zaichang-ZJU-Connector/0.1 (Windows; read-only)"


def _allowed_host(hostname: str | None, allow_official_subdomains: bool = False) -> bool:
    host = (hostname or "").lower().rstrip(".")
    if host in ALLOWED_HOSTS:
        return True
    return allow_official_subdomains and (host == "zju.edu.cn" or host.endswith(".zju.edu.cn"))


class SafeRedirectHandler(HTTPRedirectHandler):
    def __init__(self, allow_official_subdomains: bool = False) -> None:
        super().__init__()
        self.allow_official_subdomains = allow_official_subdomains

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlparse(urljoin(req.full_url, newurl))
        if target.scheme != "https" or not _allowed_host(target.hostname, self.allow_official_subdomains):
            raise RuntimeError("校园系统返回了不受信任的跳转地址，已停止连接。")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class CampusHttpClient:
    def __init__(self, allow_official_subdomains: bool = False) -> None:
        self.allow_official_subdomains = allow_official_subdomains
        self.cookies = http.cookiejar.CookieJar()
        self.opener = build_opener(HTTPCookieProcessor(self.cookies), SafeRedirectHandler(allow_official_subdomains))
        self.no_redirect_opener = build_opener(HTTPCookieProcessor(self.cookies), NoRedirectHandler())

    def request(
        self,
        url: str,
        *,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
        # ZJU SSO and the academic system can take longer than a normal web
        # request during campus-network TLS negotiation. Keep the timeout
        # bounded, but do not discard a usable schedule after 12 seconds.
        timeout: float = 30,
        follow_redirects: bool = True,
    ) -> tuple[int, str, dict[str, str]]:
        parsed = urlparse(url)
        if parsed.scheme != "https" or not _allowed_host(parsed.hostname, self.allow_official_subdomains):
            raise RuntimeError("连接器拒绝访问未列入清单的网络地址。")
        request_headers = {"User-Agent": USER_AGENT, **(headers or {})}
        request = Request(url, data=data, headers=request_headers, method="POST" if data is not None else "GET")
        try:
            opener = self.opener if follow_redirects else self.no_redirect_opener
            with opener.open(request, timeout=timeout) as response:
                body = response.read(2_000_000).decode("utf-8", errors="replace")
                return response.status, body, dict(response.headers.items())
        except HTTPError as error:
            body = error.read(100_000).decode("utf-8", errors="replace")
            return error.code, body, dict(error.headers.items())
        except (URLError, TimeoutError, OSError) as error:
            raise RuntimeError("校园系统请求超时或网络不可达，请稍后重试。") from error

    def json(self, url: str, **kwargs):
        status, body, headers = self.request(url, **kwargs)
        if not 200 <= status < 300:
            raise RuntimeError(f"校园系统请求失败（HTTP {status}）。")
        try:
            return json.loads(body), headers
        except json.JSONDecodeError as error:
            raise RuntimeError("校园系统返回了无法识别的数据。") from error

    def has_cookie(self, name: str, domain_suffix: str | None = None) -> bool:
        return any(
            cookie.name == name
            and bool(cookie.value)
            and (domain_suffix is None or cookie.domain.lstrip(".").endswith(domain_suffix))
            for cookie in self.cookies
        )
