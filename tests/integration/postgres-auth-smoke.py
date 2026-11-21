"""Smoke HTTP do autenticador PostgreSQL no contêiner FastAPI de teste."""

import json
from urllib.error import HTTPError
from urllib.request import Request, urlopen


BASE = "http://127.0.0.1:8000/api/v1/auth"


def request(path, *, data=None, token=None):
    headers = {}
    payload = None
    if data is not None:
        headers["Content-Type"] = "application/json"
        payload = json.dumps(data).encode("utf-8")
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    try:
        with urlopen(Request(f"{BASE}/{path}", data=payload, headers=headers), timeout=10) as response:
            body = response.read()
            return response.status, json.loads(body) if body else None, response.headers
    except HTTPError as error:
        with error:
            return error.code, json.load(error), error.headers


def login(email, password):
    return request("login", data={"email": email, "password": password})


def main():
    invalid = login("operator-auth@example.invalid", "senha-errada-fixture")
    for email in ("absent@example.invalid", "disabled-auth@example.invalid", "suspended-auth@example.invalid"):
        result = login(email, "operator-ci-fixture-only")
        assert result[:2] == invalid[:2]
    assert invalid[0] == 401
    assert request("me")[0] == 401

    status, validation, _ = login("operator-auth@example.invalid", "fixture-sensitive" * 100)
    assert status == 422 and validation == {"detail": "Dados de autenticação inválidos."}

    status, data, headers = login(" OPERATOR-AUTH@EXAMPLE.INVALID ", "operator-ci-fixture-only")
    assert status == 200 and data["token_type"] == "bearer"
    assert headers["Cache-Control"] == "no-store"
    operator_token = data["access_token"]

    status, operator, _ = request("me", token=operator_token)
    assert status == 200 and operator["role"] == "tenant_operator"
    assert operator["active_tenant_id"] == "00000000-0000-4000-b000-000000000001"
    assert set(operator) == {"id", "email", "full_name", "role", "tenant_id", "active_tenant_id", "expires_at_utc"}

    status, data, _ = login("global-auth@example.invalid", "global-ci-fixture-only")
    assert status == 200
    global_token = data["access_token"]
    status, administrator, _ = request("me", token=global_token)
    assert status == 200 and administrator["role"] == "super_admin"
    assert administrator["tenant_id"] is None and administrator["active_tenant_id"] is None

    assert request("logout", data={}, token=operator_token)[0] == 204
    assert request("me", token=operator_token)[0] == 401
    assert request("me", token=global_token)[0] == 200
    assert request("logout", data={}, token=global_token)[0] == 204
    print("Login scrypt, escopo, sessão e logout do FastAPI validados com PostgreSQL.")


if __name__ == "__main__":
    main()
