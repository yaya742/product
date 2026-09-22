# 天气能力

`weather/` 对应 `codex/weather` 责任分支，包含 Python/FastAPI 天气服务、Provider、配置示例和测试。

## 本地运行

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
pytest
uvicorn weather_plugin.main:app --reload
```

默认 Provider 是 Open-Meteo。正式环境可通过 `.env.example` 中的变量配置和风天气；密钥只能保存在本地环境或安全凭据存储中，不能提交到 Git。

服务向 Agent 提供当前天气、逐小时预报、户外活动评估和天气卡片。定位由调用端提供，天气服务不会自行申请设备 GPS 权限。
