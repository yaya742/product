"""Environment-backed configuration for the weather plugin."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Settings:
    """Runtime settings loaded from environment variables."""

    weather_provider: str = "open_meteo"
    qweather_api_host: str | None = None
    qweather_api_key: str | None = None
    default_timezone: str = "Asia/Shanghai"
    request_timeout_seconds: float = 8.0
    current_cache_ttl_seconds: int = 300
    forecast_cache_ttl_seconds: int = 1800

    @classmethod
    def from_env(cls) -> "Settings":
        """Build settings without requiring an additional configuration package."""

        try:
            request_timeout_seconds = float(os.getenv("WEATHER_REQUEST_TIMEOUT", "8"))
            current_cache_ttl_seconds = int(os.getenv("WEATHER_CURRENT_CACHE_TTL", "300"))
            forecast_cache_ttl_seconds = int(os.getenv("WEATHER_FORECAST_CACHE_TTL", "1800"))
        except ValueError as error:
            raise ValueError("天气服务的超时或缓存配置必须是有效数字。") from error
        if request_timeout_seconds <= 0 or current_cache_ttl_seconds <= 0 or forecast_cache_ttl_seconds <= 0:
            raise ValueError("天气服务的超时和缓存时间必须大于 0。")
        return cls(
            weather_provider=os.getenv("WEATHER_PROVIDER", "open_meteo").lower(),
            qweather_api_host=os.getenv("QWEATHER_API_HOST"),
            qweather_api_key=os.getenv("QWEATHER_API_KEY"),
            default_timezone=os.getenv("DEFAULT_TIMEZONE", "Asia/Shanghai"),
            request_timeout_seconds=request_timeout_seconds,
            current_cache_ttl_seconds=current_cache_ttl_seconds,
            forecast_cache_ttl_seconds=forecast_cache_ttl_seconds,
        )
