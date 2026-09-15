"""Agent-facing manifest and card contract for the weather plugin."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .models import (
    CurrentWeather,
    CurrentWeatherResponse,
    HourlyWeather,
    WeatherForecastResponse,
    WeatherLocation,
)


class AgentCapability(BaseModel):
    """A capability description understood by the Zaichang broker."""

    name: str
    version: str = "1"
    description: str
    method: Literal["GET"] = "GET"
    endpoint_path: str = Field(alias="endpointPath")
    input_schema: dict[str, Any] = Field(alias="inputSchema")
    output_schema: dict[str, Any] = Field(alias="outputSchema")
    effect: Literal["read"] = "read"
    required_scopes: list[str] = Field(alias="requiredScopes")
    subjects: list[Literal["self", "other", "fictional"]] = Field(default_factory=lambda: ["self"])
    worlds: list[Literal["real", "scenario"]] = Field(default_factory=lambda: ["real"])
    timeout_ms: int = Field(default=15_000, alias="timeoutMs")
    max_bytes: int = Field(default=80_000, alias="maxBytes")
    supports_idempotency: bool = Field(default=False, alias="supportsIdempotency")
    supports_inspect: bool = Field(default=False, alias="supportsInspect")
    supports_cancel: bool = Field(default=False, alias="supportsCancel")

    model_config = ConfigDict(populate_by_name=True)


class WeatherCardAction(BaseModel):
    """An action rendered by the Agent beside a weather card."""

    id: Literal["refresh", "forecast"]
    label: str


class WeatherCard(BaseModel):
    """Structured weather content for the Agent's inline card renderer."""

    schema_version: Literal["weather-card/v1"] = Field(
        default="weather-card/v1",
        alias="schemaVersion",
    )
    kind: Literal["weather"] = "weather"
    status: Literal["fresh", "stale"]
    title: str = "当前位置天气"
    location: WeatherLocation
    current: CurrentWeather
    forecast: list[HourlyWeather] = Field(default_factory=list)
    source: str
    fetched_at: datetime = Field(alias="fetchedAt")
    warnings: list[str] = Field(default_factory=list)
    actions: list[WeatherCardAction] = Field(
        default_factory=lambda: [
            WeatherCardAction(id="refresh", label="刷新天气"),
            WeatherCardAction(id="forecast", label="查看逐小时预报"),
        ],
    )

    model_config = ConfigDict(populate_by_name=True)


class AgentPluginManifest(BaseModel):
    """Manifest served to an Agent before an external provider is enabled."""

    protocol: Literal["zaichang-capability-v1"] = "zaichang-capability-v1"
    id: Literal["weather"] = "weather"
    version: str = "1"
    source_id: Literal["weather:campus"] = Field(default="weather:campus", alias="sourceId")
    trust: Literal["untrusted_disabled"] = "untrusted_disabled"
    capabilities: list[AgentCapability]
    egress_hosts: list[str] = Field(
        default_factory=lambda: ["127.0.0.1:8000", "localhost:8000"],
        alias="egressHosts",
    )
    platforms: list[str] = Field(default_factory=lambda: ["win32", "linux", "darwin", "*"])
    simulated: bool = False
    offline: Literal["read_cache", "unsupported"] = "read_cache"
    license: str = "project-owned adapter; upstream provider licenses remain applicable"
    transport: Literal["http"] = "http"
    base_path: str = Field(default="/api/weather", alias="basePath")
    location_permission: Literal["location:read"] = Field(
        default="location:read",
        alias="locationPermission",
    )
    ui: dict[str, Any] = Field(
        default_factory=lambda: {
            "cardKind": "weather",
            "schemaVersion": "weather-card/v1",
            "styleReference": "map-card",
            "inline": True,
        },
    )

    model_config = ConfigDict(populate_by_name=True)


_LOCATION_PROPERTIES = {
    "latitude": {"type": "number", "minimum": -90, "maximum": 90},
    "longitude": {"type": "number", "minimum": -180, "maximum": 180},
    "timezone": {"type": "string", "minLength": 1, "maxLength": 64},
    "source": {"type": "string", "enum": ["gps", "manual", "campus_default"]},
    "accuracy_m": {"type": "number", "exclusiveMinimum": 0, "maximum": 10_000},
    "captured_at": {"type": "string", "format": "date-time"},
}


def _location_input_schema(extra: dict[str, Any] | None = None) -> dict[str, Any]:
    properties = {**_LOCATION_PROPERTIES, **(extra or {})}
    return {
        "type": "object",
        "properties": properties,
        "required": ["latitude", "longitude"],
        "additionalProperties": False,
    }


def _card_output_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "required": [
            "schemaVersion",
            "kind",
            "status",
            "location",
            "current",
            "source",
            "fetchedAt",
        ],
        "properties": {
            "schemaVersion": {"const": "weather-card/v1"},
            "kind": {"const": "weather"},
            "status": {"type": "string", "enum": ["fresh", "stale"]},
            "location": {"type": "object"},
            "current": {"type": "object"},
            "forecast": {"type": "array", "items": {"type": "object"}},
            "source": {"type": "string"},
            "fetchedAt": {"type": "string", "format": "date-time"},
            "warnings": {"type": "array", "items": {"type": "string"}},
            "actions": {"type": "array", "items": {"type": "object"}},
        },
        "additionalProperties": False,
    }


def get_agent_manifest() -> AgentPluginManifest:
    """Return a review-required manifest for the external weather provider."""

    return AgentPluginManifest(
        capabilities=[
            AgentCapability(
                name="weather.lookup",
                description="读取当前位置天气，并返回可内嵌到对话中的天气卡片。",
                endpointPath="/api/weather/card",
                inputSchema=_location_input_schema(
                    {"hours": {"type": "integer", "minimum": 1, "maximum": 240, "default": 24}},
                ),
                outputSchema=_card_output_schema(),
                requiredScopes=["weather:read", "location:read"],
            ),
            AgentCapability(
                name="weather.outdoor_activity",
                description="根据当前位置和活动时间评估跑步、步行、骑行或户外运动。",
                endpointPath="/api/weather/outdoor-activity",
                inputSchema=_location_input_schema(
                    {
                        "start": {"type": "string", "format": "date-time"},
                        "end": {"type": "string", "format": "date-time"},
                        "activity": {
                            "type": "string",
                            "enum": [
                                "running",
                                "walking",
                                "cycling",
                                "sports",
                                "跑步",
                                "步行",
                                "骑行",
                                "运动",
                            ],
                            "default": "sports",
                        },
                    },
                ),
                outputSchema={"type": "object", "required": ["status", "status_text", "reasons"]},
                requiredScopes=["weather:read", "location:read"],
            ),
        ],
    )


def build_weather_card(
    current: CurrentWeatherResponse,
    forecast: WeatherForecastResponse,
    *,
    hours: int = 12,
) -> WeatherCard:
    """Combine normalized weather responses into the Agent inline-card shape."""

    selected_hours = max(1, min(hours, len(forecast.hours))) if forecast.hours else 0
    warnings = list(dict.fromkeys([*current.warnings, *forecast.warnings]))
    is_stale = any("过期" in warning or "超过 30 分钟" in warning for warning in warnings)
    return WeatherCard(
        status="stale" if is_stale else "fresh",
        location=current.location,
        current=current.current,
        forecast=forecast.hours[:selected_hours],
        source=current.source,
        fetchedAt=max(current.fetched_at, forecast.fetched_at),
        warnings=warnings,
    )


__all__ = [
    "AgentCapability",
    "AgentPluginManifest",
    "WeatherCard",
    "WeatherCardAction",
    "build_weather_card",
    "get_agent_manifest",
]
