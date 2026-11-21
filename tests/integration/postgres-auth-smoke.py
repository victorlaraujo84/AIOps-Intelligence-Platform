"""Smoke HTTP do autenticador PostgreSQL no contêiner FastAPI de teste."""

from concurrent.futures import ThreadPoolExecutor
import json
from threading import Barrier
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


def check_asset_write(operator, operator_b):
    own_site = "00000000-0000-4000-b000-000000000011"
    foreign_site = "00000000-0000-4000-b000-000000000013"
    missing_site = "00000000-0000-4000-b000-000000000099"
    path = "inventory/assets"
    payload = {"name": "Ativo Runtime", "hostname": "router-a", "domain": " TI ", "site_id": own_site}

    assert request(path, data={**payload, "operational_state": "UP"}, token=operator)[0] == 422
    assert request(path, data={**payload, "tenant_id": TENANT_B}, token=operator)[0] == 422
    foreign = request(path, data={**payload, "site_id": foreign_site}, token=operator)
    missing = request(path, data={**payload, "site_id": missing_site}, token=operator)
    assert foreign[:2] == missing[:2] and foreign[0] == 422

    status, asset, headers = request(path, data=payload, token=operator)
    assert status == 201 and headers["Cache-Control"] == "no-store", (status, asset)
    assert asset["tenant_id"] == TENANT_A and asset["site_id"] == own_site
    assert asset["domain"] == "ti" and asset["georeference_mode"] == "required"
    assert asset["operational_state"] == "NO_DATA"
    asset_url = f"{path}/{asset['id']}"

    def update(data, token=operator):
        return request(asset_url, data=data, token=token, method="PATCH")

    assert update({"name": "Outro tenant"}, operator_b)[0] == 404
    assert update({"site_id": foreign_site}, operator_b)[0] == 404
    assert update({"site_id": foreign_site})[0] == 422
    assert update({"site_id": None})[0] == 422
    assert update({"name": None})[0] == 422
    status, changed, _ = update({
        "hostname": None, "site_id": None, "georeference_mode": "none", "criticality": "alta",
    })
    assert status == 200 and changed["site_id"] is None and changed["hostname"] is None
    assert changed["georeference_mode"] == "none" and changed["criticality"] == "alta"
    assert update({"georeference_mode": "required"})[0] == 422

    status, logical, _ = request(path, data={"name": "Ativo Lógico Runtime"}, token=operator_b)
    assert status == 201 and logical["site_id"] is None and logical["georeference_mode"] == "none"
    status, page, _ = request(path, token=operator)
    assert status == 200 and changed in page["items"]
    assert all(row["tenant_id"] == TENANT_A for row in page["items"])

    status, data, _ = login("viewer-auth@example.invalid", "viewer-ci-fixture-only")
    assert status == 200
    viewer = data["access_token"]
    assert request(path, data=payload, token=viewer)[0] == 403
    assert update({"name": "Leitor"}, viewer)[0] == 403
    assert request("auth/logout", data={}, token=viewer)[0] == 204


def check_service_write(operator, operator_b):
    path = "inventory/services"
    payload = {
        "code": " runtime service ",
        "name": "Serviço Runtime",
        "owner_team": "Operações",
        "sla_target_pct": 99.9,
        "description": "Serviço cadastrado no smoke",
    }
    for invalid in (-0.1, 100.1, True, "99", float("inf"), float("nan")):
        assert request(path, data={**payload, "sla_target_pct": invalid}, token=operator)[0] == 422
    assert request(path, data={**payload, "tenant_id": TENANT_B}, token=operator)[0] == 422
    assert request(path, data={**payload, "operational_state": "UP"}, token=operator)[0] == 422

    status, service, headers = request(path, data=payload, token=operator)
    assert status == 201 and headers["Cache-Control"] == "no-store", (status, service)
    assert service["tenant_id"] == TENANT_A and service["code"] == "RUNTIME_SERVICE"
    assert service["domain"] == "ti" and service["criticality"] == "alta"
    assert service["operational_state"] == "NO_DATA" and service["sla_target_pct"] == 99.9
    assert request(path, data={**payload, "code": "RUNTIME_SERVICE"}, token=operator)[0] == 409

    status, other, _ = request(path, data={**payload, "sla_target_pct": 100}, token=operator_b)
    assert status == 201 and other["tenant_id"] == TENANT_B and other["sla_target_pct"] == 100
    url = f"{path}/{service['id']}"
    assert request(url, data={"name": "Outro tenant"}, token=operator_b, method="PATCH")[0] == 404
    assert request(url, data={"code": "NOVO"}, token=operator, method="PATCH")[0] == 422
    assert request(url, data={"criticality": None}, token=operator, method="PATCH")[0] == 422
    status, updated, _ = request(
        url,
        data={"owner_team": None, "sla_target_pct": None, "description": None, "domain": " INFRA "},
        token=operator,
        method="PATCH",
    )
    assert status == 200 and updated["domain"] == "infra" and updated["code"] == service["code"]
    assert all(updated[field] is None for field in ("owner_team", "sla_target_pct", "description"))
    status, page, _ = request(path, token=operator)
    assert status == 200 and updated in page["items"]
    assert all(row["tenant_id"] == TENANT_A for row in page["items"])
    status, data, _ = login("viewer-auth@example.invalid", "viewer-ci-fixture-only")
    assert status == 200
    viewer = data["access_token"]
    assert request(path, data=payload, token=viewer)[0] == 403
    assert request(url, data={"name": "Leitor"}, token=viewer, method="PATCH")[0] == 403
    assert request("auth/logout", data={}, token=viewer)[0] == 204


def check_service_dependencies(operator, operator_b):
    services = "inventory/services"
    status, page, _ = request(services, token=operator)
    assert status == 200
    by_code = {service["code"]: service["id"] for service in page["items"]}
    source, upstream = by_code["service-a"], by_code["RUNTIME_SERVICE"]
    status, third, _ = request(services, data={"code": "depends", "name": "Serviço terceiro"}, token=operator)
    assert status == 201
    third = third["id"]
    status, page_b, _ = request(services, token=operator_b)
    assert status == 200
    foreign = next(service["id"] for service in page_b["items"] if service["code"] == "service-b")

    def path(service_id):
        return f"{services}/{service_id}/dependencies"

    def link(service_id, target_id):
        return request(path(service_id), data={"upstream_service_id": target_id}, token=operator)[0]

    assert request(path(source), token=operator_b)[0] == 404
    assert request(path(source), data={"upstream_service_id": foreign}, token=operator_b)[0] == 404
    assert link(source, foreign) == 422
    assert link(source, source) == 409
    assert request(path(source), data={}, token=operator)[0] == 422

    status, assets, _ = request("inventory/assets", token=operator)
    assert status == 200
    asset = next(row for row in assets["items"] if row["name"] == "Ativo A")
    status, assets_b, _ = request("inventory/assets", token=operator_b)
    assert status == 200
    asset_b = next(row for row in assets_b["items"] if row["name"] == "Ativo B")
    assert request(path(source), data={"asset_id": asset_b["id"]}, token=operator)[0] == 422
    data = {"asset_id": asset["id"], "dependency_role": "supporting", "weight": 2.5}
    assert request(path(source), data={**data, "weight": float("inf")}, token=operator)[0] == 422
    status, asset_link, _ = request(path(source), data=data, token=operator)
    assert status == 201 and asset_link["asset_id"] == asset["id"], (status, asset_link)
    status, service_link, _ = request(path(source), data={"upstream_service_id": upstream}, token=operator)
    assert status == 201
    assert link(upstream, third) == 201
    assert link(third, source) == 409

    status, first, headers = request(f"{path(source)}?limit=1", token=operator)
    assert status == 200 and len(first["items"]) == 1 and first["next_after"]
    assert headers["Cache-Control"] == "no-store"
    status, second, _ = request(f"{path(source)}?limit=1&after={first['next_after']}", token=operator)
    assert status == 200 and len(second["items"]) == 1 and second["next_after"] is None
    by_id = {item["id"]: item for item in first["items"] + second["items"]}
    assert by_id[asset_link["id"]]["asset_name"] == "Ativo A"
    assert by_id[service_link["id"]]["upstream_service_name"] == "Serviço Runtime"

    status, data, _ = login("viewer-auth@example.invalid", "viewer-ci-fixture-only")
    assert status == 200
    viewer = data["access_token"]
    asset_link_url = f"{path(source)}/{asset_link['id']}"
    assert request(path(source), token=viewer)[0] == 200
    assert request(path(source), data={"asset_id": asset["id"]}, token=viewer)[0] == 403
    assert request(asset_link_url, token=viewer, method="DELETE")[0] == 403
    assert request(asset_link_url, token=operator_b, method="DELETE")[0] == 404
    assert request(f"{path(upstream)}/{asset_link['id']}", token=operator, method="DELETE")[0] == 404
    assert request(asset_link_url, token=operator, method="DELETE")[0] == 204
    assert request(asset_link_url, token=operator, method="DELETE")[0] == 404
    assert request(f"{path(source)}/{service_link['id']}", token=operator, method="DELETE")[0] == 204
    assert request("auth/logout", data={}, token=viewer)[0] == 204

    barrier = Barrier(2)

    def concurrent_link(edge):
        barrier.wait(timeout=5)
        return link(*edge)

    with ThreadPoolExecutor(2) as workers:
        statuses = sorted(workers.map(concurrent_link, [(source, third), (third, source)]))
    assert statuses == [201, 409], statuses


def check_topology(operator, operator_b):
    root = "inventory/topology"
    edges = f"{root}/edges"
    upstream = f"{root}/shared-upstream"
    status, assets, _ = request("inventory/assets", token=operator)
    assert status == 200
    by_name = {row["name"]: row["id"] for row in assets["items"]}
    first, second = by_name["Ativo A"], by_name["Ativo Runtime"]
    status, created, _ = request("inventory/assets", data={"name": "Topologia A3"}, token=operator)
    assert status == 201
    third = created["id"]
    status, assets, _ = request("inventory/assets", token=operator_b)
    assert status == 200
    foreign = next(row["id"] for row in assets["items"] if row["name"] == "Ativo B")

    def link(source, target, *, token=operator, **fields):
        data = {"source_asset_id": source, "target_asset_id": target, "link_type": "fiber", **fields}
        return request(edges, data=data, token=token)

    assert link(first, first)[0] == 409
    assert link(first, foreign)[0] == link(foreign, first)[0] == 422
    assert link(first, second, capacity_mbps=-0.1)[0] == 422
    assert link(first, second, capacity_mbps=float("inf"))[0] == 422
    assert link(first, second, tenant_id=TENANT_B)[0] == 422
    assert link(first, second, link_type=" ")[0] == 422
    status, primary, _ = link(first, second, capacity_mbps=1000, provider_name="Operadora", is_redundant=True)
    assert status == 201 and primary["capacity_mbps"] == 1000 and primary["is_redundant"] is True, (status, primary)
    assert link(first, second)[0] == 409
    assert link(first, second, link_type="wireless")[0] == 201
    assert request(upstream, token=operator)[:2] == (200, {"items": [], "next_after": None})

    status, path, _ = link(second, third)
    assert status == 201
    assert link(third, first)[0] == 409
    assert link(first, third, capacity_mbps=0)[0] == 201
    status, summary, headers = request(upstream, token=operator)
    assert status == 200 and headers["Cache-Control"] == "no-store"
    assert summary == {"items": [{"upstream_asset_id": first, "downstream_count": 2}], "next_after": None}
    assert request(upstream, token=operator_b)[:2] == (200, {"items": [], "next_after": None})

    status, page, _ = request(f"{edges}?limit=2", token=operator)
    assert status == 200 and len(page["items"]) == 2 and page["next_after"]
    status, next_page, _ = request(f"{edges}?limit=2&after={page['next_after']}", token=operator)
    assert status == 200 and len(next_page["items"]) == 2 and next_page["next_after"] is None
    by_id = {row["id"]: row for row in page["items"] + next_page["items"]}
    assert by_id[primary["id"]]["source_asset_name"] == "Ativo A"
    assert by_id[primary["id"]]["target_asset_name"] == "Ativo Runtime"
    assert request(edges, token=operator_b)[:2] == (200, {"items": [], "next_after": None})

    status, data, _ = login("viewer-auth@example.invalid", "viewer-ci-fixture-only")
    assert status == 200
    viewer = data["access_token"]
    path_url = f"{edges}/{path['id']}"
    assert request(edges, token=viewer)[0] == 200
    assert link(first, second, token=viewer)[0] == 403
    assert request(path_url, token=viewer, method="DELETE")[0] == 403
    assert request(path_url, token=operator_b, method="DELETE")[0] == 404
    assert request(path_url, token=operator, method="DELETE")[0] == 204
    assert request(path_url, token=operator, method="DELETE")[0] == 404
    assert request("auth/logout", data={}, token=viewer)[0] == 204

    barrier = Barrier(2)

    def concurrent_link(pair):
        barrier.wait(timeout=5)
        return link(*pair)[0]

    with ThreadPoolExecutor(2) as workers:
        statuses = sorted(workers.map(concurrent_link, [(second, third), (third, second)]))
    assert statuses == [201, 409], statuses


def check_asset_categories(operator, operator_b):
    catalog = "inventory/asset-categories"
    assets = "inventory/assets"
    payload = {"code": " Link Óptico ", "label": "Enlace óptico", "domain": " Rede "}
    assert request(catalog)[0] == 401
    assert request(catalog, data={**payload, "tenant_id": TENANT_B}, token=operator)[0] == 422

    status, category, headers = request(catalog, data=payload, token=operator)
    assert status == 201 and headers["Cache-Control"] == "no-store", (status, category)
    assert category["code"] == "link__ptico" and category["domain"] == "rede"
    assert category["tenant_id"] == TENANT_A
    assert request(catalog, data={**payload, "code": "link__ptico"}, token=operator)[0] == 409
    status, foreign, _ = request(catalog, data=payload, token=operator_b)
    assert status == 201 and foreign["tenant_id"] == TENANT_B
    status, alternate, _ = request(catalog, data={"code": "sensor", "label": "Sensor", "domain": "iot"}, token=operator)
    assert status == 201

    status, first, _ = request(f"{catalog}?limit=1", token=operator)
    assert status == 200 and first["next_after"] and len(first["items"]) == 1
    status, second, _ = request(f"{catalog}?limit=1&after={first['next_after']}", token=operator)
    assert status == 200 and second["next_after"] is None and len(second["items"]) == 1
    assert {row["id"] for row in first["items"] + second["items"]} == {category["id"], alternate["id"]}
    status, page_b, _ = request(catalog, token=operator_b)
    assert status == 200 and page_b["items"] == [foreign]

    assignment = {"name": "Ativo categorizado", "category_id": category["id"]}
    assert request(assets, data={**assignment, "category_id": foreign["id"]}, token=operator)[0] == 422
    status, asset, _ = request(assets, data=assignment, token=operator)
    assert status == 201 and asset["category_id"] == category["id"]
    assert asset["asset_type_code"] == category["code"] and asset["domain"] == "rede"
    url = f"{assets}/{asset['id']}"

    def update(data, token=operator):
        return request(url, data=data, token=token, method="PATCH")

    assert update({"category_id": foreign["id"]})[0] == 422
    assert update({"category_id": foreign["id"]}, token=operator_b)[0] == 404
    status, updated, _ = update({"category_id": alternate["id"], "domain": "energia"})
    assert status == 200 and updated["category_id"] == alternate["id"]
    assert updated["asset_type_code"] == "sensor" and updated["domain"] == "energia"
    status, retained, _ = update({"hostname": "sensor-01"})
    assert status == 200 and retained["category_id"] == alternate["id"] and retained["asset_type_code"] == "sensor"
    status, detached, _ = update({"category_id": None})
    assert status == 200 and detached["category_id"] is None and detached["asset_type_code"] is None
    assert detached["domain"] == "energia"

    status, existing, _ = request(assets, token=operator)
    assert status == 200
    legacy = next(row for row in existing["items"] if row["name"] == "Ativo A")
    status, legacy, _ = request(f"{assets}/{legacy['id']}", data={"category_id": None}, token=operator, method="PATCH")
    assert status == 200 and legacy["category_id"] is None and legacy["asset_type_code"] == "tipo_legado"

    status, data, _ = login("viewer-auth@example.invalid", "viewer-ci-fixture-only")
    assert status == 200
    viewer = data["access_token"]
    assert request(catalog, token=viewer)[0] == 200
    assert request(catalog, data=payload, token=viewer)[0] == 403
    assert update({"category_id": category["id"]}, token=viewer)[0] == 403
    assert request("auth/logout", data={}, token=viewer)[0] == 204


def check_site_catalog(operator, operator_b):
    concessions = "inventory/concessions"
    locality_types = "inventory/locality-types"
    sites = "inventory/sites"
    concession_payload = {"code": " regional ", "name": "Unidade Regional", "region": "Sul"}
    locality_payload = {"code": "ponto remoto", "label": "Ponto remoto"}
    assert request(concessions)[0] == 401
    assert request(locality_types, data={**locality_payload, "tenant_id": TENANT_B}, token=operator)[0] == 422

    status, concession, headers = request(concessions, data=concession_payload, token=operator)
    assert status == 201 and headers["Cache-Control"] == "no-store", (status, concession)
    assert concession["code"] == "REGIONAL" and concession["tenant_id"] == TENANT_A
    assert request(concessions, data=concession_payload, token=operator)[0] == 409
    status, concession_b, _ = request(concessions, data=concession_payload, token=operator_b)
    assert status == 201 and concession_b["tenant_id"] == TENANT_B

    status, locality, _ = request(locality_types, data=locality_payload, token=operator)
    assert status == 201 and locality["code"] == "PONTO_REMOTO" and locality["tenant_id"] == TENANT_A
    assert request(locality_types, data={**locality_payload, "code": "PONTO_REMOTO"}, token=operator)[0] == 409
    status, locality_b, _ = request(locality_types, data=locality_payload, token=operator_b)
    assert status == 201 and locality_b["tenant_id"] == TENANT_B

    for endpoint, own, foreign in ((concessions, concession, concession_b), (locality_types, locality, locality_b)):
        assert request(f"{endpoint}?limit=1", token=operator)[:2] == (200, {"items": [own], "next_after": None})
        assert request(endpoint, token=operator_b)[:2] == (200, {"items": [foreign], "next_after": None})

    payload = {"code": "geo-site", "name": "Site categorizado", "concession_id": concession["id"], "locality_type_id": locality["id"]}
    assert request(sites, data={**payload, "concession_id": concession_b["id"]}, token=operator)[0] == 422
    assert request(sites, data={**payload, "locality_type_id": locality_b["id"]}, token=operator)[0] == 422
    status, site, _ = request(sites, data=payload, token=operator)
    assert status == 201 and site["concession_id"] == concession["id"] and site["locality_type_id"] == locality["id"]
    path = f"{sites}/{site['id']}"

    def update(data, token=operator):
        return request(path, data=data, token=token, method="PATCH")

    assert update({"concession_id": concession_b["id"]}, token=operator_b)[0] == 404
    assert update({"concession_id": concession_b["id"], "locality_type_id": None})[0] == 422
    assert update({"locality_type_id": locality_b["id"]})[0] == 422
    status, changed, _ = update({"concession_id": None})
    assert status == 200 and changed["concession_id"] is None and changed["locality_type_id"] == locality["id"]
    status, page, _ = request(sites, token=operator)
    assert status == 200 and changed in page["items"]

    status, data, _ = login("viewer-auth@example.invalid", "viewer-ci-fixture-only")
    assert status == 200
    viewer = data["access_token"]
    assert request(locality_types, token=viewer)[0] == 200
    assert request(concessions, data=concession_payload, token=viewer)[0] == 403
    assert request(locality_types, data=locality_payload, token=viewer)[0] == 403
    assert update({"concession_id": concession["id"]}, token=viewer)[0] == 403
    assert request("auth/logout", data={}, token=viewer)[0] == 204


def check_site_location(operator, operator_b):
    sites = "inventory/sites"
    payload = {"code": "map-site", "name": "Site no mapa", "address": " Rua de teste, 123 ", "cep": "01234-567"}
    assert request(sites, data={**payload, "cep": "01310-X99"}, token=operator)[0] == 422
    assert request(sites, data={**payload, "coord_verified": True}, token=operator)[0] == 422
    status, site, _ = request(sites, data=payload, token=operator)
    assert status == 201 and site["address"] == "Rua de teste, 123" and site["cep"] == "01234567"
    assert site["coord_precision"] == "pendente" and site["coord_verified"] is False
    assert site["latitude"] is None and site["longitude"] is None
    path = f"{sites}/{site['id']}"
    verify = f"{path}/verify-coords"

    coords = {"latitude": -23.5, "longitude": -46.5}
    assert request(verify, data=coords, token=operator_b, method="PATCH")[0] == 404
    for invalid in (
        {}, {"latitude": 0}, {**coords, "latitude": -90.1}, {**coords, "longitude": 180.1},
        {**coords, "longitude": float("inf")}, {**coords, "latitude": float("nan")},
        {**coords, "latitude": True}, {**coords, "latitude": "-23.5"}, {**coords, "tenant_id": TENANT_B},
    ):
        assert request(verify, data=invalid, token=operator, method="PATCH")[0] == 422

    status, data, _ = login("viewer-auth@example.invalid", "viewer-ci-fixture-only")
    assert status == 200
    viewer = data["access_token"]
    assert request(verify, data=coords, token=viewer, method="PATCH")[0] == 403
    assert request("auth/logout", data={}, token=viewer)[0] == 204

    status, verified, headers = request(verify, data=coords, token=operator, method="PATCH")
    assert status == 200 and headers["Cache-Control"] == "no-store", (status, verified)
    assert verified["latitude"] == coords["latitude"] and verified["longitude"] == coords["longitude"]
    assert verified["coord_verified"] is True and verified["coord_precision"] == "manual_verificada"
    status, changed, _ = request(path, data={"address": "Rua corrigida", "cep": None}, token=operator, method="PATCH")
    assert status == 200 and changed["address"] == "Rua corrigida" and changed["cep"] is None
    assert changed["latitude"] == coords["latitude"] and changed["longitude"] == coords["longitude"]
    assert changed["coord_verified"] is True
    status, page, _ = request(sites, token=operator)
    assert status == 200 and changed in page["items"]


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
    check_asset_write(operator_token, operator_b_token)
    check_service_write(operator_token, operator_b_token)
    check_service_dependencies(operator_token, operator_b_token)
    check_topology(operator_token, operator_b_token)
    check_asset_categories(operator_token, operator_b_token)
    check_site_catalog(operator_token, operator_b_token)
    check_site_location(operator_token, operator_b_token)
    assert request("auth/logout", data={}, token=operator_b_token)[0] == 204
    assert request("auth/logout", data={}, token=operator_token)[0] == 204
    assert request("auth/me", token=operator_token)[0] == 401
    assert request("auth/me", token=global_token)[0] == 200
    assert request("auth/logout", data={}, token=global_token)[0] == 204
    print("Login, troca de tenant, leitura isolada, inventário, catálogos, georreferenciamento, dependências, topologia e logout validados com PostgreSQL.")


if __name__ == "__main__":
    main()
