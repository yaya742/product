from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
from typing import Any


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def app_data_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        raise RuntimeError("当前系统没有可用的 LOCALAPPDATA 目录。")
    result = Path(base) / "CodexZjuStudentInfo"
    result.mkdir(parents=True, exist_ok=True)
    return result


def _blob(data: bytes) -> tuple[DATA_BLOB, Any]:
    buffer = ctypes.create_string_buffer(data)
    return DATA_BLOB(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))), buffer


def protect(data: bytes, description: str) -> bytes:
    if os.name != "nt":
        raise RuntimeError("校园登录信息目前只支持 Windows 当前用户加密。")
    source, source_buffer = _blob(data)
    entropy, entropy_buffer = _blob(b"zaichang-zju-connector-v1")
    output = DATA_BLOB()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    ok = crypt32.CryptProtectData(
        ctypes.byref(source), description, ctypes.byref(entropy), None, None, 0,
        ctypes.byref(output),
    )
    _ = (source_buffer, entropy_buffer)
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        kernel32.LocalFree(output.pbData)


def unprotect(data: bytes) -> bytes:
    if os.name != "nt":
        raise RuntimeError("校园登录信息目前只支持 Windows 当前用户解密。")
    source, source_buffer = _blob(data)
    entropy, entropy_buffer = _blob(b"zaichang-zju-connector-v1")
    output = DATA_BLOB()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(source), None, ctypes.byref(entropy), None, None, 0,
        ctypes.byref(output),
    )
    _ = (source_buffer, entropy_buffer)
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        kernel32.LocalFree(output.pbData)


def write_encrypted_json(path: Path, value: Any, description: str) -> None:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    protected = protect(encoded, description)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(base64.b64encode(protected).decode("ascii"), encoding="ascii")
    os.replace(temporary, path)


def read_encrypted_json(path: Path) -> Any:
    protected = base64.b64decode(path.read_text(encoding="ascii"), validate=True)
    return json.loads(unprotect(protected).decode("utf-8"))
