from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import tkinter as tk
from tkinter import messagebox, ttk

from .security import app_data_dir, read_encrypted_json, write_encrypted_json


@dataclass(frozen=True)
class Credentials:
    username: str
    password: str


def credentials_path() -> Path:
    return app_data_dir() / "credentials.dpapi"


def load_credentials() -> Credentials:
    path = credentials_path()
    if not path.exists():
        raise FileNotFoundError("还没有保存浙大统一身份认证信息。")
    value = read_encrypted_json(path)
    username = str(value.get("username", "")).strip()
    password = str(value.get("password", ""))
    if not username or not password:
        raise ValueError("保存的登录信息不完整。")
    return Credentials(username=username, password=password)


def forget_credentials() -> None:
    path = credentials_path()
    if path.exists():
        path.unlink()


def show_credentials_dialog() -> bool:
    root = tk.Tk()
    root.title("连接浙大校园资料")
    root.geometry("430x275")
    root.resizable(False, False)
    root.attributes("-topmost", True)

    frame = ttk.Frame(root, padding=24)
    frame.pack(fill="both", expand=True)
    ttk.Label(frame, text="浙大统一身份认证", font=("Microsoft YaHei UI", 14, "bold")).pack(anchor="w")
    ttk.Label(
        frame,
        text="登录信息只用 Windows 当前用户加密保存在本机，不会发送给 DeepSeek。\n这是兼容连接，并非浙大官方授权接口。",
        wraplength=380,
        justify="left",
    ).pack(anchor="w", pady=(6, 18))

    username = tk.StringVar()
    password = tk.StringVar()
    ttk.Label(frame, text="学号 / 工号").pack(anchor="w")
    username_entry = ttk.Entry(frame, textvariable=username)
    username_entry.pack(fill="x", pady=(3, 10))
    ttk.Label(frame, text="密码").pack(anchor="w")
    password_entry = ttk.Entry(frame, textvariable=password, show="●")
    password_entry.pack(fill="x", pady=(3, 16))

    result = {"saved": False}

    def save() -> None:
        account = username.get().strip()
        secret = password.get()
        if not account or not secret:
            messagebox.showerror("无法保存", "请填写学号 / 工号和密码。", parent=root)
            return
        write_encrypted_json(
            credentials_path(),
            {"schema_version": 1, "username": account, "password": secret},
            "Zaichang ZJU credentials",
        )
        result["saved"] = True
        root.destroy()

    buttons = ttk.Frame(frame)
    buttons.pack(fill="x")
    ttk.Button(buttons, text="取消", command=root.destroy).pack(side="right")
    ttk.Button(buttons, text="安全保存", command=save).pack(side="right", padx=(0, 8))
    username_entry.focus_set()
    root.bind("<Return>", lambda _event: save())
    root.bind("<Escape>", lambda _event: root.destroy())
    root.mainloop()
    return result["saved"]

