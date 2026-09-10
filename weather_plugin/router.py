"""FastAPI routes exposed by the weather plugin."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request

from .models import (
    ActivityEvaluation,
    ActivityKind,
    CurrentWeatherResponse,
    WeatherForecastResponse,
    WeatherLocation,
    parse_activity_kind,
)
from .providers.base import WeatherProviderError
from .service import WeatherService

router = APIRouter(prefix="/api/weather", tags=["天气"])


def _location(
    latitude: float,
    longitude: float,
    timezone: str,
    request: Request,
) -> WeatherLocation:
    settings = request.app.state.weather_settings
    return WeatherLocation(
        latitude=latitude,
        longitude=longitude,
        timezone=timezone or settings.default_timezone,
    )


def _service(request: Request) -> WeatherService:
    return request.app.state.weather_service


def _provider_error(error: WeatherProviderError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message, "retryable": error.retryable},
    )


@router.get("/current", response_model=CurrentWeatherResponse)
async def get_current_weather(
    request: Request,
    latitude: Annotated[float, Query(ge=-90, le=90)],
    longitude: Annotated[float, Query(ge=-180, le=180)],
    timezone: Annotated[str, Query(min_length=1, max_length=64)] = "",
) -> CurrentWeatherResponse:
    location = _location(latitude, longitude, timezone, request)
    try:
        return await _service(request).get_current(location)
    except WeatherProviderError as error:
        raise _provider_error(error) from error


@router.get("/forecast", response_model=WeatherForecastResponse)
async def get_weather_forecast(
    request: Request,
    latitude: Annotated[float, Query(ge=-90, le=90)],
    longitude: Annotated[float, Query(ge=-180, le=180)],
    hours: Annotated[int, Query(ge=1, le=240)] = 48,
    timezone: Annotated[str, Query(min_length=1, max_length=64)] = "",
) -> WeatherForecastResponse:
    location = _location(latitude, longitude, timezone, request)
    try:
        return await _service(request).get_forecast(location, hours)
    except WeatherProviderError as error:
        raise _provider_error(error) from error


@router.get("/outdoor-activity", response_model=ActivityEvaluation)
async def evaluate_outdoor_activity(
    request: Request,
    latitude: Annotated[float, Query(ge=-90, le=90)],
    longitude: Annotated[float, Query(ge=-180, le=180)],
    start: datetime,
    end: datetime,
    activity: str = ActivityKind.SPORTS.value,
    timezone: Annotated[str, Query(min_length=1, max_length=64)] = "",
) -> ActivityEvaluation:
    location = _location(latitude, longitude, timezone, request)
    try:
        activity_kind = parse_activity_kind(activity)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    try:
        return await _service(request).evaluate_outdoor_activity(
            location,
            activity_kind,
            start,
            end,
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except WeatherProviderError as error:
        raise _provider_error(error) from error
