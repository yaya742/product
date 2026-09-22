"""Provider protocol and shared provider errors."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Protocol

from ..models import (
    CurrentWeather,
    CurrentWeatherResponse,
    HourlyWeather,
    WeatherForecastResponse,
    WeatherLocation,
)


class WeatherProviderError(RuntimeError):
    """A controlled error raised when an upstream provider cannot answer."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 503,
        retryable: bool = True,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.retryable = retryable


class WeatherProvider(Protocol):
    """Interface implemented by every weather data source."""

    source: str

    async def get_current(self, location: WeatherLocation) -> CurrentWeatherResponse:
        """Return normalized current weather."""

    async def get_forecast(
        self,
        location: WeatherLocation,
        hours: int,
    ) -> WeatherForecastResponse:
        """Return normalized hourly forecast."""


def parse_datetime(value: str | int | float | datetime, timezone_name: str) -> datetime:
    """Parse provider timestamps and keep naive timestamps usable."""

    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, (int, float)):
        parsed = datetime.fromtimestamp(value, timezone.utc)
    else:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))

    if parsed.tzinfo is not None:
        return parsed

    try:
        from zoneinfo import ZoneInfo

        return parsed.replace(tzinfo=ZoneInfo(timezone_name))
    except Exception:
        return parsed.replace(tzinfo=timezone.utc)
