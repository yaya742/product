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


class WeatherLocation(BaseModel):
    """A WGS84 coordinate and the timezone used for display."""

    model_config = ConfigDict(frozen=True)

    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    timezone: str = Field(min_length=1, max_length=64)


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
    status: str = Field(pattern="^(suitable|caution|unsuitable)$")
    evaluated_from: datetime
    evaluated_to: datetime
    reasons: list[str] = Field(min_length=1)
    source: str
    fetched_at: datetime
    forecast_hours_used: int = Field(ge=1)
