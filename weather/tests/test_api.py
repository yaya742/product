from fastapi.testclient import TestClient

from weather_plugin.main import create_app


def test_health() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_invalid_coordinates_are_rejected() -> None:
    with TestClient(create_app()) as client:
        response = client.get(
            "/api/weather/current",
            params={"latitude": 100, "longitude": 120},
        )

    assert response.status_code == 422


def test_timezone_is_optional_for_gps_clients() -> None:
    with TestClient(create_app()) as client:
        spec = client.get("/openapi.json").json()

    parameters = spec["paths"]["/api/weather/current"]["get"]["parameters"]
    timezone_parameter = next(item for item in parameters if item["name"] == "timezone")

    assert timezone_parameter["required"] is False


def test_post_endpoints_are_available_for_android() -> None:
    with TestClient(create_app()) as client:
        spec = client.get("/openapi.json").json()

    assert "post" in spec["paths"]["/api/weather/current"]
    assert "post" in spec["paths"]["/api/weather/forecast"]
    assert "post" in spec["paths"]["/api/weather/outdoor-activity"]


def test_docs_page_is_chinese_and_swagger_is_preserved() -> None:
    with TestClient(create_app()) as client:
        chinese_docs = client.get("/docs")
        swagger_docs = client.get("/swagger")

    assert chinese_docs.status_code == 200
    assert "校园天气插件" in chinese_docs.text
    assert "查询当前天气" in chinese_docs.text
    assert swagger_docs.status_code == 200


def test_agent_manifest_matches_map_style_contract() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/api/weather/manifest")

    assert response.status_code == 200
    manifest = response.json()
    assert manifest["protocol"] == "zaichang-capability-v1"
    assert manifest["trust"] == "untrusted_disabled"
    assert manifest["ui"] == {
        "cardKind": "weather",
        "schemaVersion": "weather-card/v1",
        "styleReference": "map-card",
        "inline": True,
    }
    capabilities = {item["name"]: item for item in manifest["capabilities"]}
    assert set(capabilities) == {"weather.lookup", "weather.outdoor_activity"}
    assert capabilities["weather.lookup"]["requiredScopes"] == [
        "weather:read",
        "location:read",
    ]
    assert capabilities["weather.lookup"]["method"] == "GET"
    assert capabilities["weather.lookup"]["endpointPath"] == "/api/weather/card"
