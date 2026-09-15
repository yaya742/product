from datetime import datetime, timedelta, timezone

import pytest

from weather_plugin.agent import build_weather_card, get_agent_manifest
from weather_plugin.models import (
    ActivityKind,
    CurrentWeather,
    CurrentWeatherResponse,
    HourlyWeather,
    LocationSource,
    WeatherForecastResponse,
    WeatherLocation,
    WeatherLocationRequest,
    parse_activity_kind,
)
from weather_plugin.service import WeatherService


class FakeProvider:
    source = "fake"

    def __init__(self, points: list[HourlyWeather]) -> None:
        self.points = points
        self.forecast_calls = 0

    async def get_current(self, location: WeatherLocation) -> CurrentWeatherResponse:
        now = datetime.now(timezone.utc)
        return CurrentWeatherResponse(
            source=self.source,
            fetched_at=now,
            location=location,
            current=CurrentWeather(
                observed_at=now,
                temperature_c=20,
                feels_like_c=20,
                humidity_percent=50,
                precipitation_mm=0,
                precipitation_probability_percent=0,
                wind_speed_mps=1,
                weather_code="0",
            ),
        )

    async def get_forecast(self, location: WeatherLocation, hours: int) -> WeatherForecastResponse:
        self.forecast_calls += 1
        return WeatherForecastResponse(
            source=self.source,
            fetched_at=datetime.now(timezone.utc),
            location=location,
            hours=self.points[:hours],
        )


def make_point(at: datetime, **overrides: object) -> HourlyWeather:
    values = {
        "forecast_time": at,
        "temperature_c": 20,
        "feels_like_c": 20,
        "humidity_percent": 50,
        "precipitation_mm": 0,
        "precipitation_probability_percent": 0,
        "wind_speed_mps": 2,
        "weather_code": "0",
        "condition_text": "晴",
        "precipitation_type": "none",
    }
    values.update(overrides)
    return HourlyWeather(**values)


def test_chinese_activity_alias_is_supported() -> None:
    assert parse_activity_kind("跑步").value == "running"


def test_gps_payload_uses_default_timezone() -> None:
    payload = WeatherLocationRequest(
        latitude=30,
        longitude=120,
        accuracy_m=35,
        source=LocationSource.GPS,
    )

    location = payload.to_location("Asia/Shanghai")

    assert location.timezone == "Asia/Shanghai"
    assert location.accuracy_m == 35


@pytest.mark.asyncio
async def test_forecast_is_cached() -> None:
    location = WeatherLocation(latitude=30, longitude=120, timezone="Asia/Shanghai")
    start = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    provider = FakeProvider([make_point(start + timedelta(hours=index)) for index in range(4)])
    service = WeatherService(provider)

    await service.get_forecast(location, 4)
    await service.get_forecast(location, 4)

    assert provider.forecast_calls == 1


@pytest.mark.asyncio
async def test_stale_gps_location_returns_a_warning() -> None:
    location = WeatherLocation(
        latitude=30,
        longitude=120,
        timezone="UTC",
        source=LocationSource.GPS,
        accuracy_m=1_500,
        captured_at=datetime.now(timezone.utc) - timedelta(minutes=31),
    )
    provider = FakeProvider([])
    service = WeatherService(provider)

    result = await service.get_current(location)

    assert result.location.source == LocationSource.GPS
    assert any("30 分钟" in warning for warning in result.warnings)
    assert any("1,500 米" in warning for warning in result.warnings)


@pytest.mark.asyncio
async def test_outdoor_activity_is_unsuitable_for_heavy_rain() -> None:
    location = WeatherLocation(latitude=30, longitude=120, timezone="UTC")
    start = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    provider = FakeProvider(
        [
            make_point(
                start,
                precipitation_mm=2,
                precipitation_probability_percent=80,
                weather_code="65",
                condition_text="大雨",
                precipitation_type="rain",
            )
        ]
    )
    service = WeatherService(provider)

    result = await service.evaluate_outdoor_activity(
        location,
        ActivityKind.RUNNING,
        start,
        start + timedelta(hours=1),
    )

    assert result.status == "unsuitable"
    assert result.forecast_hours_used == 1


def test_weather_card_uses_map_style_metadata_and_normalized_data() -> None:
    now = datetime.now(timezone.utc)
    location = WeatherLocation(latitude=30, longitude=120, timezone="UTC")
    current = CurrentWeatherResponse(
        source="fake",
        fetched_at=now,
        location=location,
        current=CurrentWeather(
            observed_at=now,
            temperature_c=20,
            feels_like_c=20,
            humidity_percent=50,
            precipitation_mm=0,
            precipitation_probability_percent=0,
            wind_speed_mps=1,
            weather_code="0",
            condition_text="晴",
        ),
    )
    forecast = WeatherForecastResponse(
        source="fake",
        fetched_at=now,
        location=location,
        hours=[make_point(now + timedelta(hours=index)) for index in range(3)],
    )

    card = build_weather_card(current, forecast, hours=2)

    assert card.schema_version == "weather-card/v1"
    assert card.kind == "weather"
    assert len(card.forecast) == 2
    assert [action.id for action in card.actions] == ["refresh", "forecast"]


def test_agent_manifest_requires_review_before_enablement() -> None:
    manifest = get_agent_manifest()

    assert manifest.trust == "untrusted_disabled"
    assert manifest.location_permission == "location:read"
