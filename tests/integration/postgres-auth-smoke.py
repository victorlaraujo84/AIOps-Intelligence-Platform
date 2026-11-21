"""Smoke HTTP do autenticador PostgreSQL no contêiner FastAPI de teste."""

import json
from urllib.error import HTTPError
from urllib.request import Request, urlopen


BASE = "http://127.0.0.1:8000/api/v1"
TENANT_A = "00000000-0000-4000-b000-000000000001"
SUSPENDED = "00000000-0000-4000-b000-000000000002"
TENANT_B = "00000000-0000-4000-b000-000000000003"


def request(path, *, data=None, token=None, method=None):
    headers = {}
    payload = None
    if data is not None:
        headers["Content-Type"] = "application/json"
        payload = json.dumps(data).encode("utf-8")
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    try:
        with urlopen(Request(f"{BASE}/{path}", data=payload, headers=headers, method=method), timeout=10) as response:
            body = response.read()
            return response.status, json.loads(body) if body else None, response.headers
    except HTTPError as error:
        with error:
            return error.code, json.load(error), error.headers


def login(email, password):
    return request("auth/login", data={"email": email, "password": password})


def check_site_write(operator, operator_b):
    payload = {"code": "runtime-site", "name": "Site Runtime A", "municipality": "São Paulo", "uf": "sp"}
    assert request("inventory/sites", data={**payload, "tenant_id": TENANT_B}, token=operator)[0] == 422
    status, site, headers = request("inventory/sites", data=payload, token=operator)
    assert status == 201 and site["tenant_id"] == TENANT_A and site["code"] == "RUNTIME-SITE" and site["uf"] == "SP"
    assert headers["Cache-Control"] == "no-store"
    assert request("inventory/sites", data=payload, token=operator)[0] == 409
    site_url = f"inventory/sites/{site['id']}"
    assert request(site_url, data={"name": "Outro tenant"}, token=operator_b, method="PATCH")[0] == 404
    assert request(site_url, data={"name": None}, token=operator, method="PATCH")[0] == 422
    status, updated, _ = request(
        site_url, data={"name": "Site Runtime atualizado", "municipality": None}, token=operator, method="PATCH",
    )
    assert status == 200 and updated["name"] == "Site Runtime atualizado" and updated["municipality"] is None
    status, site_b, _ = request("inventory/sites", data={**payload, "name": "Site Runtime B"}, token=operator_b)
    assert status == 201 and site_b["tenant_id"] == TENANT_B
    status, data, _ = login("viewer-auth@example.invalid", "viewer-ci-fixture-only")
    assert status == 200
    viewer = data["access_token"]
    assert request("inventory/sites", data=payload, token=viewer)[0] == 403
    assert request(site_url, data={"name": "Leitor"}, token=viewer, method="PATCH")[0] == 403
    assert request("auth/logout", data={}, token=viewer)[0] == 204
    status, final_page, _ = request("inventory/sites", token=operator)
    assert status == 200 and any(item["id"] == site["id"] and item["name"] == updated["name"] for item in final_page["items"])
    assert all(item["tenant_id"] == TENANT_A for item in final_page["items"])


def main():
    invalid = login("operator-auth@example.invalid", "senha-errada-fixture")
    for email in ("absent@example.invalid", "disabled-auth@example.invalid", "suspended-auth@example.invalid"):
        result = login(email, "operator-ci-fixture-only")
        assert result[:2] == invalid[:2]
    assert invalid[0] == 401
    assert request("auth/me")[0] == 401

    status, validation, _ = login("operator-auth@example.invalid", "fixture-sensitive" * 100)
    assert status == 422 and validation == {"detail": "Dados de autenticação inválidos."}

    status, data, headers = login(" OPERATOR-AUTH@EXAMPLE.INVALID ", "operator-ci-fixture-only")
    assert status == 200 and data["token_type"] == "bearer"
    assert headers["Cache-Control"] == "no-store"
    operator_token = data["access_token"]

    status, operator, _ = request("auth/me", token=operator_token)
    assert status == 200 and operator["role"] == "tenant_operator"
    assert operator["active_tenant_id"] == TENANT_A
    assert set(operator) == {"id", "email", "full_name", "role", "tenant_id", "active_tenant_id", "expires_at_utc"}

    status, data, _ = login("global-auth@example.invalid", "global-ci-fixture-only")
    assert status == 200
    global_token = data["access_token"]
    status, administrator, _ = request("auth/me", token=global_token)
    assert status == 200 and administrator["role"] == "super_admin"
    assert administrator["tenant_id"] is None and administrator["active_tenant_id"] is None

    assert request("inventory/sites")[0] == 401
    assert request("inventory/sites", token=global_token)[0] == 409
    assert request("inventory/sites", data={"code": "global", "name": "Global"}, token=global_token)[0] == 409
    assert request("auth/switch-tenant", data={"tenant_id": SUSPENDED}, token=global_token)[0] == 404
    assert request("auth/switch-tenant", data={"tenant_id": TENANT_B}, token=operator_token)[0] == 403
    status, page, headers = request(f"inventory/sites?limit=1&tenant_id={TENANT_B}", token=operator_token)
    assert status == 200 and [row["code"] for row in page["items"]] == ["a-1"]
    assert headers["Cache-Control"] == "no-store"
    status, second_page, _ = request(f"inventory/sites?limit=1&after={page['next_after']}", token=operator_token)
    assert status == 200 and [row["code"] for row in second_page["items"]] == ["a-2"]
    assert second_page["next_after"] is None

    status, data, _ = login("operator-b-auth@example.invalid", "operator-ci-fixture-only")
    assert status == 200
    operator_b_token = data["access_token"]
    for resource, expected_name in (("assets", "Ativo B"), ("services", "Serviço B"), ("sites", "Site B1")):
        status, page_b, _ = request(f"inventory/{resource}", token=operator_b_token)
        assert status == 200 and [row["name"] for row in page_b["items"]] == [expected_name]
        assert all(row["tenant_id"] == TENANT_B for row in page_b["items"])

    for selected, expected_codes in ((TENANT_B, ["b-1"]), (TENANT_A, ["a-1", "a-2"])):
        status, selected_body, _ = request("auth/switch-tenant", data={"tenant_id": selected}, token=global_token)
        assert status == 200 and selected_body["active_tenant_id"] == selected
        status, global_page, _ = request("inventory/sites", token=global_token)
        assert status == 200 and [row["code"] for row in global_page["items"]] == expected_codes

    check_site_write(operator_token, operator_b_token)
    assert request("auth/logout", data={}, token=operator_b_token)[0] == 204
    assert request("auth/logout", data={}, token=operator_token)[0] == 204
    assert request("auth/me", token=operator_token)[0] == 401
    assert request("auth/me", token=global_token)[0] == 200
    assert request("auth/logout", data={}, token=global_token)[0] == 204
    print("Login, troca de tenant, leitura isolada, gravação de sites e logout validados com PostgreSQL.")


if __name__ == "__main__":
    main()
