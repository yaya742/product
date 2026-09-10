"""Weather service orchestration, caching, fallback, and activity rules."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from .models import (
    ActivityEvaluation,
    ActivityKind,
    CurrentWeatherResponse,
    HourlyWeather,
    WeatherForecastResponse,
    WeatherLocation,
)
from .providers.base import WeatherProvider, WeatherProviderError


@dataclass(slots=True)
class _CacheEntry:
    expires_at: float
    value: object


class InMemoryCache:
    """Small process-local cache for the first deployment."""

    def __init__(self) -> None:
        self._entries: dict[str, _CacheEntry] = {}
        self._lock = asyncio.Lock()

    async def get(self, key: str) -> object | None:
        async with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            if entry.expires_at <= time.monotonic():
                self._entries.pop(key, None)
                return None
            return entry.value

    async def set(self, key: str, value: object, ttl_seconds: int) -> None:
        async with self._lock:
            self._entries[key] = _CacheEntry(time.monotonic() + ttl_seconds, value)


class FallbackProvider:
    """Try the configured primary provider, then a development-safe fallback."""

    def __init__(self, primary: WeatherProvider, fallback: WeatherProvider) -> None:
        self.primary = primary
        self.fallback = fallback
        self.source = primary.source

    async def get_current(self, location: WeatherLocation) -> CurrentWeatherResponse:
        try:
            return await self.primary.get_current(location)
        except WeatherProviderError as error:
            if not error.retryable:
                raise
            return await self.fallback.get_current(location)

    async def get_forecast(
        self,
        location: WeatherLocation,
        hours: int,
    ) -> WeatherForecastResponse:
        try:
            return await self.primary.get_forecast(location, hours)
        except WeatherProviderError as error:
            if not error.retryable:
                raise
            return await self.fallback.get_forecast(location, hours)


class WeatherService:
    """Use a provider to expose the plugin's three core capabilities."""

    def __init__(
        self,
        provider: WeatherProvider,
        *,
        cache: InMemoryCache | None = None,
        current_cache_ttl_seconds: int = 300,
        forecast_cache_ttl_seconds: int = 1800,
    ) -> None:
        self.provider = provider
        self.cache = cache or InMemoryCache()
        self.current_cache_ttl_seconds = current_cache_ttl_seconds
        self.forecast_cache_ttl_seconds = forecast_cache_ttl_seconds

    async def get_current(self, location: WeatherLocation) -> CurrentWeatherResponse:
        key = self._location_key("current", location)
        cached = await self.cache.get(key)
        if isinstance(cached, CurrentWeatherResponse):
            return cached
        response = await self.provider.get_current(location)
        await self.cache.set(key, response, self.current_cache_ttl_seconds)
        return response

    async def get_forecast(self, location: WeatherLocation, hours: int) -> WeatherForecastResponse:
        key = self._location_key(f"forecast:{hours}", location)
        cached = await self.cache.get(key)
        if isinstance(cached, WeatherForecastResponse):
            return cached
        response = await self.provider.get_forecast(location, hours)
        await self.cache.set(key, response, self.forecast_cache_ttl_seconds)
        return response

    async def evaluate_outdoor_activity(
        self,
        location: WeatherLocation,
        activity: ActivityKind,
        start: datetime,
        end: datetime,
    ) -> ActivityEvaluation:
        start = self._with_timezone(start, location.timezone)
        end = self._with_timezone(end, location.timezone)
        if end <= start:
            raise ValueError("活动结束时间必须晚于开始时间。")
        if end - start > timedelta(hours=24):
            raise ValueError("活动评估时间范围不能超过 24 小时。")

        now = datetime.now(start.tzinfo or timezone.utc)
        hours_until_end = int((end - now).total_seconds() / 3600) + 2
        forecast_hours = max(1, min(240, hours_until_end))
        forecast = await self.get_forecast(location, forecast_hours)
        relevant_hours = [
            point for point in forecast.hours if start <= point.forecast_time <= end
        ]
        if not relevant_hours:
            raise WeatherProviderError(
                "FORECAST_NOT_COVERED",
                "天气预报没有覆盖所选活动时间。",
                status_code=422,
                retryable=False,
            )

        status, reasons = self._evaluate_points(relevant_hours)
        return ActivityEvaluation(
            activity=activity,
            activity_text={
                ActivityKind.RUNNING: "跑步",
                ActivityKind.WALKING: "步行",
                ActivityKind.CYCLING: "骑行",
                ActivityKind.SPORTS: "户外运动",
            }[activity],
            status=status,
            status_text={
                "suitable": "适合",
                "caution": "需要注意",
                "unsuitable": "不建议",
            }[status],
            evaluated_from=relevant_hours[0].forecast_time,
            evaluated_to=relevant_hours[-1].forecast_time,
            reasons=reasons,
            source=forecast.source,
            fetched_at=forecast.fetched_at,
            forecast_hours_used=len(relevant_hours),
        )

    @staticmethod
    def _evaluate_points(points: list[HourlyWeather]) -> tuple[str, list[str]]:
        reasons: list[str] = []
        max_rain_probability = max(
            (point.precipitation_probability_percent or 0 for point in points),
            default=0,
        )
        max_precipitation = max((point.precipitation_mm for point in points), default=0)
        max_wind = max((point.wind_speed_mps for point in points), default=0)
        minimum_temperature = min(point.temperature_c for point in points)
        maximum_temperature = max(point.temperature_c for point in points)
        has_severe_condition = any(
            WeatherService._is_severe_condition(point) for point in points
        )

        if max_rain_probability >= 60 or max_precipitation >= 1:
            reasons.append("活动时段降雨可能性较高，建议准备雨具或调整时间。")
        elif max_rain_probability >= 30 or max_precipitation > 0:
            reasons.append("活动时段存在降雨可能，出发前建议再次确认天气。")
        if minimum_temperature < 5 or maximum_temperature > 35:
            reasons.append("活动时段温度偏低或偏高。")
        elif minimum_temperature < 10 or maximum_temperature > 30:
            reasons.append("活动时段温度不太舒适。")
        if max_wind >= 10:
            reasons.append("活动时段风力较大，户外活动存在不便。")
        elif max_wind >= 6:
            reasons.append("活动时段有较明显风力。")
        if has_severe_condition:
            reasons.append("活动时段可能出现雷电、强降水、降雪或冰雹。")

        if not reasons:
            return "suitable", ["活动时段未发现明显天气风险。"]
        if has_severe_condition or max_rain_probability >= 60 or max_precipitation >= 1 or max_wind >= 10:
            return "unsuitable", reasons
        if minimum_temperature < 5 or maximum_temperature > 35:
            return "unsuitable", reasons
        return "caution", reasons

    @staticmethod
    def _is_severe_condition(point: HourlyWeather) -> bool:
        text = f"{point.condition_text or ''}{point.precipitation_type or ''}"
        if any(word in text for word in ("雷", "冰雹", "thunder", "hail")):
            return True
        return point.weather_code in {"95", "96", "99"}

    @staticmethod
    def _location_key(prefix: str, location: WeatherLocation) -> str:
        return f"{prefix}:{location.latitude:.4f}:{location.longitude:.4f}:{location.timezone}"

    @staticmethod
    def _with_timezone(value: datetime, timezone_name: str) -> datetime:
        if value.tzinfo is not None:
            return value
        try:
            from zoneinfo import ZoneInfo

            return value.replace(tzinfo=ZoneInfo(timezone_name))
        except Exception:
            return value.replace(tzinfo=timezone.utc)
