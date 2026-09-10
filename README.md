# 校园天气插件

天气插件面向中国大学生，为校园 Agent 提供三个只读能力：

- 当前天气：`GET /api/weather/current`
- 逐小时预报：`GET /api/weather/forecast`
- 户外活动评估：`GET /api/weather/outdoor-activity`

默认使用 Open-Meteo，适合本地开发和接口联调。正式环境可设置 `WEATHER_PROVIDER=qweather`，并配置和风天气专用 API Host 与 API Key；和风天气不可用时会自动回退到 Open-Meteo。

## 本地运行

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -e ".[dev]"
uvicorn weather_plugin.main:app --reload
```

启动后打开 <http://127.0.0.1:8000/docs> 查看接口文档。

## 示例请求

```text
GET /api/weather/current?latitude=30.27&longitude=120.15&timezone=Asia/Shanghai
GET /api/weather/forecast?latitude=30.27&longitude=120.15&hours=48&timezone=Asia/Shanghai
GET /api/weather/outdoor-activity?latitude=30.27&longitude=120.15&start=2026-09-10T18:00:00%2B08:00&end=2026-09-10T20:00:00%2B08:00&activity=跑步&timezone=Asia/Shanghai
```

## 设计约束

- Android 只上传经纬度，不直接持有天气服务密钥。
- Provider 输出先转换为统一模型，Agent 不读取上游原始 JSON。
- 当前天气缓存 5 分钟，预报缓存 30 分钟。
- 户外活动建议由规则计算，模型只负责解释结果。
- 当前缓存为进程内缓存；多实例部署时应替换为 Redis。
