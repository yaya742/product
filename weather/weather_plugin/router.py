"""FastAPI routes exposed by the weather plugin."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request

from .agent import AgentPluginManifest, WeatherCard, build_weather_card, get_agent_manifest
from .models import (
    ActivityEvaluation,
    ActivityKind,
    CurrentWeatherResponse,
    LocationSource,
    OutdoorActivityRequest,
    WeatherForecastRequest,
    WeatherForecastResponse,
    WeatherLocation,
    WeatherLocationRequest,
    parse_activity_kind,
)
from .providers.base import WeatherProviderError
from .service import WeatherService

router = APIRouter(prefix="/api/weather", tags=["天气"])


@router.get("/manifest", response_model=AgentPluginManifest)
async def get_agent_plugin_manifest() -> AgentPluginManifest:
    """Return the review-required capability manifest for Zaichang Agent."""

    return get_agent_manifest()


def _location(
    latitude: float,
    longitude: float,
    timezone: str | None,
    source: LocationSource,
    accuracy_m: float | None,
    captured_at: datetime | None,
    request: Request,
) -> WeatherLocation:
    settings = request.app.state.weather_settings
    return WeatherLocation(
        latitude=latitude,
        longitude=longitude,
        timezone=timezone or settings.default_timezone,
        source=source,
        accuracy_m=accuracy_m,
        captured_at=captured_at,
    )


def _service(request: Request) -> WeatherService:
    return request.app.state.weather_service


def _payload_location(payload: WeatherLocationRequest, request: Request) -> WeatherLocation:
    return payload.to_location(request.app.state.weather_settings.default_timezone)


def _provider_error(error: WeatherProviderError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message, "retryable": error.retryable},
    )


@router.get("/card", response_model=WeatherCard)
async def get_weather_card(
    request: Request,
    latitude: Annotated[float, Query(ge=-90, le=90)],
    longitude: Annotated[float, Query(ge=-180, le=180)],
    hours: Annotated[int, Query(ge=1, le=240)] = 12,
    timezone: Annotated[str | None, Query(min_length=1, max_length=64)] = None,
    source: LocationSource = LocationSource.GPS,
    accuracy_m: Annotated[float | None, Query(gt=0, le=10_000)] = None,
    captured_at: datetime | None = None,
) -> WeatherCard:
    """Return one inline-card payload for an Agent weather lookup."""

    location = _location(
        latitude,
        longitude,
        timezone,
        source,
        accuracy_m,
        captured_at,
        request,
    )
    try:
        service = _service(request)
        current = await service.get_current(location)
        forecast = await service.get_forecast(location, hours)
        return build_weather_card(current, forecast, hours=hours)
    except WeatherProviderError as error:
        raise _provider_error(error) from error


@router.get("/current", response_model=CurrentWeatherResponse)
async def get_current_weather(
    request: Request,
    latitude: Annotated[float, Query(ge=-90, le=90)],
    longitude: Annotated[float, Query(ge=-180, le=180)],
    timezone: Annotated[str | None, Query(min_length=1, max_length=64)] = None,
    source: LocationSource = LocationSource.GPS,
    accuracy_m: Annotated[float | None, Query(gt=0, le=10_000)] = None,
    captured_at: datetime | None = None,
) -> CurrentWeatherResponse:
    location = _location(
        latitude,
        longitude,
        timezone,
        source,
        accuracy_m,
        captured_at,
        request,
    )
    try:
        return await _service(request).get_current(location)
    except WeatherProviderError as error:
        raise _provider_error(error) from error


@router.post("/current", response_model=CurrentWeatherResponse)
async def post_current_weather(
    request: Request,
    payload: WeatherLocationRequest,
) -> CurrentWeatherResponse:
    """Receive a GPS payload from the Android client."""

    try:
        return await _service(request).get_current(_payload_location(payload, request))
    except WeatherProviderError as error:
        raise _provider_error(error) from error


@router.get("/forecast", response_model=WeatherForecastResponse)
async def get_weather_forecast(
    request: Request,
    latitude: Annotated[float, Query(ge=-90, le=90)],
    longitude: Annotated[float, Query(ge=-180, le=180)],
    hours: Annotated[int, Query(ge=1, le=240)] = 48,
    timezone: Annotated[str | None, Query(min_length=1, max_length=64)] = None,
    source: LocationSource = LocationSource.GPS,
    accuracy_m: Annotated[float | None, Query(gt=0, le=10_000)] = None,
    captured_at: datetime | None = None,
) -> WeatherForecastResponse:
    location = _location(
        latitude,
        longitude,
        timezone,
        source,
        accuracy_m,
        captured_at,
        request,
    )
    try:
        return await _service(request).get_forecast(location, hours)
    except WeatherProviderError as error:
        raise _provider_error(error) from error


@router.post("/forecast", response_model=WeatherForecastResponse)
async def post_weather_forecast(
    request: Request,
    payload: WeatherForecastRequest,
) -> WeatherForecastResponse:
    """Receive a GPS payload and return an hourly forecast."""

    try:
        return await _service(request).get_forecast(
            _payload_location(payload, request),
            payload.hours,
        )
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
    timezone: Annotated[str | None, Query(min_length=1, max_length=64)] = None,
    source: LocationSource = LocationSource.GPS,
    accuracy_m: Annotated[float | None, Query(gt=0, le=10_000)] = None,
    captured_at: datetime | None = None,
) -> ActivityEvaluation:
    location = _location(
        latitude,
        longitude,
        timezone,
        source,
        accuracy_m,
        captured_at,
        request,
    )
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


@router.post("/outdoor-activity", response_model=ActivityEvaluation)
async def post_evaluate_outdoor_activity(
    request: Request,
    payload: OutdoorActivityRequest,
) -> ActivityEvaluation:
    """Receive a GPS payload and evaluate an outdoor activity window."""

    try:
        activity_kind = parse_activity_kind(payload.activity)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    try:
        return await _service(request).evaluate_outdoor_activity(
            _payload_location(payload, request),
            activity_kind,
            payload.start,
            payload.end,
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except WeatherProviderError as error:
        raise _provider_error(error) from error
