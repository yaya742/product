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
