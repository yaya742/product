"""Open-Meteo provider used for local development and fallback."""

from __future__ import annotations

from datetime import datetime, timezone
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


class OpenMeteoProvider:
    """Fetch and normalize Open-Meteo forecast responses."""

    source = "open_meteo"
    forecast_url = "https://api.open-meteo.com/v1/forecast"

    def __init__(self, http_client: httpx.AsyncClient) -> None:
        self.http_client = http_client

    async def get_current(self, location: WeatherLocation) -> CurrentWeatherResponse:
        payload = await self._request(
            {
                "latitude": location.latitude,
                "longitude": location.longitude,
                "current": ",".join(
                    [
                        "temperature_2m",
                        "relative_humidity_2m",
                        "apparent_temperature",
                        "precipitation",
                        "precipitation_probability",
                        "weather_code",
                        "wind_speed_10m",
                        "is_day",
                    ]
                ),
                "timezone": "auto",
                "temperature_unit": "celsius",
                "wind_speed_unit": "ms",
                "precipitation_unit": "mm",
            }
        )
        response_location = location.model_copy(
            update={"timezone": payload.get("timezone", location.timezone)}
        )
        current = payload.get("current")
        if not isinstance(current, dict):
            raise WeatherProviderError("INVALID_RESPONSE", "天气服务返回的当前天气数据无效。", retryable=False)

        fetched_at = datetime.now(timezone.utc)
        return CurrentWeatherResponse(
            source=self.source,
            fetched_at=fetched_at,
            location=response_location,
            current=CurrentWeather(
                observed_at=parse_datetime(current["time"], response_location.timezone),
                temperature_c=float(current["temperature_2m"]),
                feels_like_c=float(current["apparent_temperature"]),
                humidity_percent=float(current["relative_humidity_2m"]),
                precipitation_mm=float(current.get("precipitation", 0)),
                precipitation_probability_percent=self._optional_percent(
                    current.get("precipitation_probability")
                ),
                wind_speed_mps=float(current["wind_speed_10m"]),
                weather_code=str(current["weather_code"]),
                condition_text=self._weather_code_text(current.get("weather_code")),
                precipitation_type=self._precipitation_type(current.get("weather_code")),
                is_day=bool(current["is_day"]) if current.get("is_day") is not None else None,
            ),
        )

    async def get_forecast(
        self,
        location: WeatherLocation,
        hours: int,
    ) -> WeatherForecastResponse:
        payload = await self._request(
            {
                "latitude": location.latitude,
                "longitude": location.longitude,
                "hourly": ",".join(
                    [
                        "temperature_2m",
                        "relative_humidity_2m",
                        "apparent_temperature",
                        "precipitation",
                        "precipitation_probability",
                        "weather_code",
                        "wind_speed_10m",
                    ]
                ),
                "forecast_days": 16,
                "timezone": "auto",
                "temperature_unit": "celsius",
                "wind_speed_unit": "ms",
                "precipitation_unit": "mm",
            }
        )
        response_location = location.model_copy(
            update={"timezone": payload.get("timezone", location.timezone)}
        )
        hourly = payload.get("hourly")
        if not isinstance(hourly, dict) or not hourly.get("time"):
            raise WeatherProviderError("INVALID_RESPONSE", "天气服务返回的预报数据无效。", retryable=False)

        times = hourly["time"][:hours]
        points = [
            HourlyWeather(
                forecast_time=parse_datetime(time_value, response_location.timezone),
                temperature_c=float(self._at(hourly, "temperature_2m", index)),
                feels_like_c=float(self._at(hourly, "apparent_temperature", index)),
                humidity_percent=float(self._at(hourly, "relative_humidity_2m", index)),
                precipitation_mm=float(self._at(hourly, "precipitation", index, 0)),
                precipitation_probability_percent=self._optional_percent(
                    self._at(hourly, "precipitation_probability", index, None)
                ),
                wind_speed_mps=float(self._at(hourly, "wind_speed_10m", index)),
                weather_code=str(self._at(hourly, "weather_code", index)),
                condition_text=self._weather_code_text(self._at(hourly, "weather_code", index)),
                precipitation_type=self._precipitation_type(self._at(hourly, "weather_code", index)),
            )
            for index, time_value in enumerate(times)
        ]
        return WeatherForecastResponse(
            source=self.source,
            fetched_at=datetime.now(timezone.utc),
            location=response_location,
            hours=points,
        )

    async def _request(self, params: dict[str, Any]) -> dict[str, Any]:
        try:
            response = await self.http_client.get(self.forecast_url, params=params)
            response.raise_for_status()
            payload = response.json()
        except httpx.TimeoutException as error:
            raise WeatherProviderError("PROVIDER_TIMEOUT", "天气服务响应超时。") from error
        except httpx.HTTPStatusError as error:
            raise WeatherProviderError("PROVIDER_HTTP_ERROR", "天气服务暂时不可用。") from error
        except (httpx.RequestError, ValueError) as error:
            raise WeatherProviderError("PROVIDER_UNAVAILABLE", "无法连接天气服务。") from error

        if not isinstance(payload, dict):
            raise WeatherProviderError("INVALID_RESPONSE", "天气服务返回格式无效。", retryable=False)
        return payload

    @staticmethod
    def _at(values: dict[str, list[Any]], key: str, index: int, default: Any = None) -> Any:
        items = values.get(key, [])
        if index >= len(items):
            if default is not None:
                return default
            raise WeatherProviderError("INVALID_RESPONSE", f"天气服务缺少字段：{key}。", retryable=False)
        return items[index]

    @staticmethod
    def _optional_percent(value: Any) -> float | None:
        return None if value is None else float(value)

    @staticmethod
    def _weather_code_text(code: Any) -> str:
        return {
            0: "晴",
            1: "大部晴朗",
            2: "局部多云",
            3: "阴",
            45: "雾",
            48: "雾凇",
            51: "毛毛雨",
            53: "毛毛雨",
            55: "毛毛雨",
            56: "冻毛毛雨",
            57: "冻毛毛雨",
            61: "小雨",
            63: "中雨",
            65: "大雨",
            66: "冻雨",
            67: "冻雨",
            71: "小雪",
            73: "中雪",
            75: "大雪",
            77: "雪粒",
            80: "阵雨",
            81: "阵雨",
            82: "强阵雨",
            85: "阵雪",
            86: "强阵雪",
            95: "雷雨",
            96: "雷雨伴冰雹",
            99: "雷雨伴冰雹",
        }.get(code, "未知天气")

    @staticmethod
    def _precipitation_type(code: Any) -> str:
        if code in {51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99}:
            return "rain"
        if code in {71, 73, 75, 77, 85, 86}:
            return "snow"
        return "none"
