from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from .security import app_data_dir, read_encrypted_json, write_encrypted_json


def _bundles_dir() -> Path:
    result = app_data_dir() / "bundles"
    result.mkdir(parents=True, exist_ok=True)
    return result


def _index_path() -> Path:
    return app_data_dir() / "bundle-index.json"


def _read_index() -> dict[str, Any]:
    path = _index_path()
    if not path.exists():
        return {"schema_version": 1, "items": []}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {"schema_version": 1, "items": []}
    except (OSError, json.JSONDecodeError):
        return {"schema_version": 1, "items": []}


def _write_index(index: dict[str, Any]) -> None:
    path = _index_path()
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def save_academic_bundle(semester_id: str, normalized: dict[str, Any]) -> str:
    now = datetime.now(timezone.utc).isoformat()
    bundle_id = hashlib.sha256(f"academic:{semester_id}".encode("utf-8")).hexdigest()[:32]
    payload = {
        "schema_version": 1,
        "kind": "academic",
        "semester_id": semester_id,
        "fetched_at": now,
        "normalized": normalized,
    }
    write_encrypted_json(_bundles_dir() / f"{bundle_id}.dpapi", payload, "Zaichang ZJU normalized bundle")
    index = _read_index()
    items = [item for item in index.get("items", []) if item.get("bundle_id") != bundle_id]
    items.insert(0, {"bundle_id": bundle_id, "kind": "academic", "semester_id": semester_id, "fetched_at": now})
    index["items"] = items[:24]
    _write_index(index)
    return bundle_id


def save_calendar_bundle(academic_year: str, normalized: dict[str, Any]) -> str:
    now = datetime.now(timezone.utc).isoformat()
    bundle_id = hashlib.sha256(f"calendar:{academic_year}".encode("utf-8")).hexdigest()[:32]
    payload = {
        "schema_version": 1,
        "kind": "calendar",
        "academic_year": academic_year,
        "fetched_at": now,
        "normalized": normalized,
    }
    write_encrypted_json(_bundles_dir() / f"{bundle_id}.dpapi", payload, "Zaichang ZJU public calendar bundle")
    index = _read_index()
    items = [item for item in index.get("items", []) if item.get("bundle_id") != bundle_id]
    items.insert(0, {"bundle_id": bundle_id, "kind": "calendar", "academic_year": academic_year, "fetched_at": now})
    index["items"] = items[:24]
    _write_index(index)
    return bundle_id


def save_notices_bundle(normalized: dict[str, Any], scope: str = "latest") -> str:
    now = datetime.now(timezone.utc).isoformat()
    safe_scope = str(scope or "latest")[:180]
    bundle_id = hashlib.sha256(f"notices:zdbk-official:{safe_scope}".encode("utf-8")).hexdigest()[:32]
    payload = {
        "schema_version": 1,
        "kind": "notices",
        "scope": safe_scope,
        "fetched_at": now,
        "normalized": normalized,
    }
    write_encrypted_json(_bundles_dir() / f"{bundle_id}.dpapi", payload, "Zaichang ZJU public notices bundle")
    index = _read_index()
    items = [item for item in index.get("items", []) if item.get("bundle_id") != bundle_id]
    items.insert(0, {"bundle_id": bundle_id, "kind": "notices", "scope": safe_scope, "fetched_at": now})
    index["items"] = items[:24]
    _write_index(index)
    return bundle_id


def load_bundle(bundle_id: str) -> dict[str, Any]:
    if not re_bundle_id(bundle_id):
        raise ValueError("资料包编号不合法。")
    path = _bundles_dir() / f"{bundle_id}.dpapi"
    if not path.exists():
        raise FileNotFoundError("没有找到所需的本机校园资料缓存。")
    value = read_encrypted_json(path)
    if not isinstance(value, dict):
        raise ValueError("校园资料缓存格式不正确。")
    return value


def history(limit: int) -> list[dict[str, Any]]:
    return list(_read_index().get("items", []))[: max(1, min(100, limit))]


def forget_bundles() -> int:
    directory = _bundles_dir()
    removed = 0
    for path in directory.glob("*.dpapi"):
        try:
            path.unlink()
            removed += 1
        except OSError:
            pass
    _write_index({"schema_version": 1, "items": []})
    return removed


def re_bundle_id(value: str) -> bool:
    return len(value) == 32 and all(character in "0123456789abcdef" for character in value.lower())
