"""Application factory for the weather plugin."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

import httpx
from fastapi import FastAPI
from fastapi.responses import HTMLResponse

from .config import Settings
from .docs import get_chinese_docs
from .providers import OpenMeteoProvider, QWeatherProvider, WeatherProvider
from .router import router
from .service import FallbackProvider, WeatherService


def _build_provider(
    settings: Settings,
    http_client: httpx.AsyncClient,
) -> WeatherProvider:
    open_meteo = OpenMeteoProvider(http_client)
    if settings.weather_provider == "open_meteo":
        return open_meteo
    if settings.weather_provider != "qweather":
        raise ValueError("WEATHER_PROVIDER 只能是 open_meteo 或 qweather。")
    if not settings.qweather_api_host or not settings.qweather_api_key:
        raise ValueError("使用 qweather 时必须配置 QWEATHER_API_HOST 和 QWEATHER_API_KEY。")
    qweather = QWeatherProvider(
        http_client,
        settings.qweather_api_host,
        settings.qweather_api_key,
    )
    return FallbackProvider(qweather, open_meteo)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Create the FastAPI application."""

    runtime_settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        http_client = httpx.AsyncClient(timeout=runtime_settings.request_timeout_seconds)
        app.state.weather_settings = runtime_settings
        app.state.weather_http_client = http_client
        app.state.weather_service = WeatherService(
            _build_provider(runtime_settings, http_client),
            current_cache_ttl_seconds=runtime_settings.current_cache_ttl_seconds,
            forecast_cache_ttl_seconds=runtime_settings.forecast_cache_ttl_seconds,
        )
        yield
        await http_client.aclose()

    app = FastAPI(
        title="校园天气插件",
        version="0.1.0",
        description="为中国大学生校园 Agent 提供中文的当前天气、逐小时预报和户外活动评估。",
        docs_url="/swagger",
        lifespan=lifespan,
    )
    app.include_router(router)

    @app.get("/docs", include_in_schema=False)
    async def chinese_docs() -> HTMLResponse:
        return get_chinese_docs()

    @app.get("/health", tags=["系统"])
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()

__all__ = ["app", "create_app"]
