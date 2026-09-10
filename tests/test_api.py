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
