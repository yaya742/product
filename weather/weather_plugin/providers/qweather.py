"""QWeather provider for production use."""

from __future__ import annotations

from datetime import datetime, timezone
import math
from typing import Any

import httpx

from ..models import (
    CurrentWeather,
    CurrentWeatherResponse,
    HourlyWeather,
    WeatherForecastResponse,
    WeatherLocation,
)
from .base import WeatherProviderError, parse_datetime


class QWeatherProvider:
    """Fetch and normalize the current QWeather v1 API response."""

    source = "qweather"

    def __init__(self, http_client: httpx.AsyncClient, api_host: str, api_key: str) -> None:
        self.http_client = http_client
        self.api_host = api_host.rstrip("/")
        self.api_key = api_key

    async def get_current(self, location: WeatherLocation) -> CurrentWeatherResponse:
        payload = await self._request(
            f"/weather/v1/current/{location.latitude:.2f}/{location.longitude:.2f}",
            {"localTime": "true", "lang": "zh"},
        )
        condition = payload.get("condition", {})
        current_time = datetime.now(timezone.utc)
        current = CurrentWeather(
            observed_at=current_time,
            temperature_c=self._number(payload.get("temperature", {}).get("value")),
            feels_like_c=self._number(payload.get("feelsLike", {}).get("value")),
            humidity_percent=self._fraction_to_percent(payload.get("humidity")),
            precipitation_mm=self._number(payload.get("precipitation", {}).get("amount", {}).get("value")),
            wind_speed_mps=self._number(payload.get("wind", {}).get("speed", {}).get("value")),
            weather_code=str(condition.get("code", "unknown")),
            condition_text=condition.get("text"),
            precipitation_type=payload.get("precipitation", {}).get("type"),
        )
        return CurrentWeatherResponse(
            source=self.source,
            fetched_at=current_time,
            location=location,
            current=current,
        )

    async def get_forecast(
        self,
        location: WeatherLocation,
        hours: int,
    ) -> WeatherForecastResponse:
        payload = await self._request(
            f"/weather/v1/hourly/{location.latitude:.2f}/{location.longitude:.2f}",
            {"hours": str(hours), "localTime": "true", "lang": "zh"},
        )
        raw_hours = payload.get("hours")
        if not isinstance(raw_hours, list):
            raise WeatherProviderError("INVALID_RESPONSE", "和风天气返回的预报数据无效。", retryable=False)

        fetched_at = datetime.now(timezone.utc)
        points = [self._parse_hour(item, location.timezone) for item in raw_hours[:hours]]
        if not points:
            raise WeatherProviderError("INVALID_RESPONSE", "和风天气没有返回可用的预报时段。", retryable=False)
        return WeatherForecastResponse(
            source=self.source,
            fetched_at=fetched_at,
            location=location,
            hours=points,
        )

    async def _request(self, path: str, params: dict[str, str]) -> dict[str, Any]:
        try:
            response = await self.http_client.get(
                f"{self.api_host}{path}",
                params=params,
                headers={"X-QW-Api-Key": self.api_key, "Accept-Encoding": "gzip"},
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.TimeoutException as error:
            raise WeatherProviderError("PROVIDER_TIMEOUT", "天气服务响应超时。") from error
        except httpx.HTTPStatusError as error:
            raise WeatherProviderError("PROVIDER_HTTP_ERROR", "和风天气服务暂时不可用。") from error
        except (httpx.RequestError, ValueError) as error:
            raise WeatherProviderError("PROVIDER_UNAVAILABLE", "无法连接和风天气服务。") from error

        if not isinstance(payload, dict):
            raise WeatherProviderError("INVALID_RESPONSE", "和风天气返回格式无效。", retryable=False)
        if payload.get("code") not in (None, "200", 200):
            raise WeatherProviderError(
                "PROVIDER_REJECTED",
                f"和风天气请求失败，错误码：{payload.get('code')}。",
                status_code=502,
                retryable=False,
            )
        return payload

    @classmethod
    def _parse_hour(cls, item: dict[str, Any], timezone_name: str) -> HourlyWeather:
        condition = item.get("condition", {})
        temperature = item.get("temperature", {})
        feels_like = item.get("feelsLike", {})
        wind = item.get("wind", {})
        precipitation = item.get("precipitation", {})
        return HourlyWeather(
            forecast_time=parse_datetime(item["forecastTime"], timezone_name),
            temperature_c=cls._number(temperature.get("value")),
            feels_like_c=cls._number(feels_like.get("value")),
            humidity_percent=cls._fraction_to_percent(item.get("humidity")),
            precipitation_mm=cls._number(precipitation.get("amount", {}).get("value")),
            precipitation_probability_percent=cls._optional_percent(
                precipitation.get("probability")
            ),
            wind_speed_mps=cls._number(wind.get("speed", {}).get("value")),
            weather_code=str(condition.get("code", "unknown")),
            condition_text=condition.get("text"),
            precipitation_type=precipitation.get("type"),
        )

    @staticmethod
    def _number(value: Any) -> float:
        try:
            number = float(value)
        except (TypeError, ValueError) as error:
            raise WeatherProviderError("INVALID_RESPONSE", "和风天气返回了无效的数值。", retryable=False) from error
        if not math.isfinite(number):
            raise WeatherProviderError("INVALID_RESPONSE", "和风天气返回了无效的数值。", retryable=False)
        return number

    @staticmethod
    def _fraction_to_percent(value: Any) -> float:
        if value is None:
            raise WeatherProviderError("INVALID_RESPONSE", "和风天气返回了缺失的湿度。", retryable=False)
        number = float(value)
        return number * 100 if 0 <= number <= 1 else number

    @staticmethod
    def _optional_percent(value: Any) -> float | None:
        if value is None:
            return None
        number = float(value)
        return number * 100 if 0 <= number <= 1 else number
