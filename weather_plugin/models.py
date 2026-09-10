"""Canonical weather models shared by providers and API consumers."""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class ActivityKind(str, Enum):
    """Activities currently supported by the outdoor activity evaluator."""

    RUNNING = "running"
    WALKING = "walking"
    CYCLING = "cycling"
    SPORTS = "sports"


class LocationSource(str, Enum):
    """How the app obtained the location used for a weather query."""

    GPS = "gps"
    MANUAL = "manual"
    CAMPUS_DEFAULT = "campus_default"


ACTIVITY_ALIASES = {
    "running": ActivityKind.RUNNING,
    "跑步": ActivityKind.RUNNING,
    "walking": ActivityKind.WALKING,
    "步行": ActivityKind.WALKING,
    "cycling": ActivityKind.CYCLING,
    "骑行": ActivityKind.CYCLING,
    "sports": ActivityKind.SPORTS,
    "运动": ActivityKind.SPORTS,
}


def parse_activity_kind(value: str) -> ActivityKind:
    """Accept stable machine codes and Chinese activity names."""

    activity = ACTIVITY_ALIASES.get(value.strip().lower())
    if activity is None:
        raise ValueError("活动类型只能是跑步、步行、骑行或运动。")
    return activity


class WeatherLocation(BaseModel):
    """A WGS84 coordinate and the timezone used for display."""

    model_config = ConfigDict(frozen=True)

    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    timezone: str = Field(min_length=1, max_length=64)
    source: LocationSource = LocationSource.GPS
    accuracy_m: float | None = Field(default=None, gt=0, le=10_000)
    captured_at: datetime | None = None


class CurrentWeather(BaseModel):
    """Normalized current conditions."""

    observed_at: datetime
    temperature_c: float
    feels_like_c: float
    humidity_percent: float = Field(ge=0, le=100)
    precipitation_mm: float = Field(ge=0)
    precipitation_probability_percent: float | None = Field(default=None, ge=0, le=100)
    wind_speed_mps: float = Field(ge=0)
    weather_code: str
    condition_text: str | None = None
    precipitation_type: str | None = None
    is_day: bool | None = None


class HourlyWeather(BaseModel):
    """Normalized hourly forecast point."""

    forecast_time: datetime
    temperature_c: float
    feels_like_c: float
    humidity_percent: float = Field(ge=0, le=100)
    precipitation_mm: float = Field(ge=0)
    precipitation_probability_percent: float | None = Field(default=None, ge=0, le=100)
    wind_speed_mps: float = Field(ge=0)
    weather_code: str
    condition_text: str | None = None
    precipitation_type: str | None = None


class CurrentWeatherResponse(BaseModel):
    """Plugin response for current weather queries."""

    source: str
    fetched_at: datetime
    location: WeatherLocation
    current: CurrentWeather
    warnings: list[str] = Field(default_factory=list)


class WeatherForecastResponse(BaseModel):
    """Plugin response for hourly forecast queries."""

    source: str
    fetched_at: datetime
    location: WeatherLocation
    hours: list[HourlyWeather]
    warnings: list[str] = Field(default_factory=list)


class ActivityEvaluation(BaseModel):
    """Rule-based evaluation for an outdoor activity window."""

    activity: ActivityKind
    activity_text: str
    status: str = Field(pattern="^(suitable|caution|unsuitable)$")
    status_text: str
    evaluated_from: datetime
    evaluated_to: datetime
    reasons: list[str] = Field(min_length=1)
    source: str
    fetched_at: datetime
    forecast_hours_used: int = Field(ge=1)
    warnings: list[str] = Field(default_factory=list)
