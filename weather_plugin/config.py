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

        return cls(
            weather_provider=os.getenv("WEATHER_PROVIDER", "open_meteo").lower(),
            qweather_api_host=os.getenv("QWEATHER_API_HOST"),
            qweather_api_key=os.getenv("QWEATHER_API_KEY"),
            default_timezone=os.getenv("DEFAULT_TIMEZONE", "Asia/Shanghai"),
            request_timeout_seconds=float(os.getenv("WEATHER_REQUEST_TIMEOUT", "8")),
            current_cache_ttl_seconds=int(os.getenv("WEATHER_CURRENT_CACHE_TTL", "300")),
            forecast_cache_ttl_seconds=int(os.getenv("WEATHER_FORECAST_CACHE_TTL", "1800")),
        )
