from __future__ import annotations

from dataclasses import dataclass
import html
import re
from urllib.parse import urlencode

from .credentials import Credentials
from .http_client import CampusHttpClient


LOGIN_URL = "https://zjuam.zju.edu.cn/cas/login"
PUBLIC_KEY_URL = "https://zjuam.zju.edu.cn/cas/v2/getPubKey"


@dataclass
class AuthenticatedSession:
    client: CampusHttpClient


def _execution(body: str) -> str:
    match = re.search(r'name=["\']execution["\'][^>]*value=["\']([^"\']+)', body, re.IGNORECASE)
    if not match:
        match = re.search(r'value=["\']([^"\']+)["\'][^>]*name=["\']execution["\']', body, re.IGNORECASE)
    if not match:
        raise RuntimeError("统一身份认证页面缺少登录会话信息。")
    return html.unescape(match.group(1))


def _encrypt_password(password: str, modulus_hex: str, exponent_hex: str) -> str:
    raw = password.encode("utf-8")
    if not raw:
        raise RuntimeError("密码不能为空。")
    encrypted = pow(int.from_bytes(raw, "big"), int(exponent_hex, 16), int(modulus_hex, 16))
    width = max(128, (len(modulus_hex) + 1) // 2 * 2)
    return f"{encrypted:0{width}x}"


def authenticate(credentials: Credentials) -> AuthenticatedSession:
    client = CampusHttpClient()
    status, login_body, _headers = client.request(LOGIN_URL)
    if status != 200:
        raise RuntimeError(f"无法打开浙大统一身份认证（HTTP {status}）。")
    execution = _execution(login_body)
    public_key, _ = client.json(PUBLIC_KEY_URL)
    modulus = str(public_key.get("modulus", ""))
    exponent = str(public_key.get("exponent", ""))
    if not modulus or not exponent:
        raise RuntimeError("统一身份认证没有返回可用公钥。")
    encoded = urlencode(
        {
            "username": credentials.username,
            "password": _encrypt_password(credentials.password, modulus, exponent),
            "execution": execution,
            "_eventId": "submit",
            "rememberMe": "true",
        }
    ).encode("utf-8")
    status, body, _headers = client.request(
        LOGIN_URL,
        data=encoded,
        headers={"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"},
        follow_redirects=False,
    )
    if not client.has_cookie("iPlanetDirectoryPro", "zju.edu.cn"):
        if "验证码" in body or "captcha" in body.lower():
            raise RuntimeError("统一身份认证要求额外验证码，请稍后重试或先在浏览器完成安全校验。")
        raise RuntimeError("统一身份认证没有完成，请检查学号、密码或账号状态。")
    return AuthenticatedSession(client=client)
