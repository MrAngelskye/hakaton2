"""Security review regressions against an isolated local HTTP server."""
import http.client
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import secrets
import socket
import threading
import unittest

from test_access import Client, portal


class SecurityReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(os.environ.get("EDU_TEST_DIR", str(Path.cwd() / "data/tests"))).resolve()
        cls.path = cls.root / ("security-" + secrets.token_hex(8) + ".sqlite3")
        cls.server = portal.create_server(cls.path, port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.host = f"127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        for suffix in ("", "-wal", "-shm"):
            path = Path(str(cls.path) + suffix).resolve()
            if path.parent != cls.root:
                raise RuntimeError("Test database escaped its directory.")
            path.unlink(missing_ok=True)

    def setUp(self):
        portal.PortalHandler.failures = {}

    def raw(self, target="/api/login", body=None, headers=None, method="POST"):
        if isinstance(body, dict):
            body = json.dumps(body).encode()
        if body is None:
            body = b""
        fields = [("Host", self.host), ("Content-Type", "application/json"),
                  ("Content-Length", str(len(body)))] if headers is None else headers
        request = f"{method} {target} HTTP/1.1\r\nConnection: close\r\n".encode()
        request += b"".join(f"{name}: {value}\r\n".encode("ascii") for name, value in fields)
        with socket.create_connection(("127.0.0.1", self.server.server_port), timeout=5) as connection:
            connection.sendall(request + b"\r\n" + body)
            connection.shutdown(socket.SHUT_WR)
            response = http.client.HTTPResponse(connection)
            response.begin()
            payload = response.read()
            self.assertIn("application/json", response.headers.get("Content-Type", ""))
            return response.status, json.loads(payload)

    def login_body(self):
        return {"username": "admin", "password": "Demo2026!", "role": "admin"}

    def teacher(self):
        client = Client(self.base)
        self.assertEqual(client.login("teacher-garden", "teacher")[0], 200)
        return client

    def test_foreign_host_is_rejected_for_read_and_login_even_with_matching_origin(self):
        foreign = f"rebinding.invalid:{self.server.server_port}"
        self.assertEqual(self.raw("/api/public/bootstrap", headers=[("Host", foreign)], method="GET")[0], 403)
        self.assertEqual(self.raw("/api/session", headers=[("Host", foreign)], method="GET")[0], 403)
        body = json.dumps(self.login_body()).encode()
        self.assertEqual(self.raw(body=body, headers=[("Host", foreign), ("Origin", "http://" + foreign),
                         ("Content-Type", "application/json"), ("Content-Length", str(len(body)))])[0], 403)
        self.assertEqual(Client(self.base).request("/api/public/bootstrap")[0], 200)

    def test_loopback_alias_and_matching_origin_still_work(self):
        alias = f"localhost:{self.server.server_port}"
        self.assertEqual(self.raw("/api/public/bootstrap", headers=[("Host", alias)], method="GET")[0], 200)
        body = json.dumps(self.login_body()).encode()
        self.assertEqual(self.raw(body=body, headers=[("Host", self.host), ("Origin", self.base),
                         ("Content-Type", "application/json"), ("Content-Length", str(len(body)))])[0], 200)

    def test_missing_duplicate_and_malformed_host_are_normal_errors(self):
        for fields in ([], [("Host", self.host), ("Host", self.host)],
                       [("Host", "user@" + self.host)], [("Host", "[invalid")],
                       [("Host", self.host + "/unexpected")]):
            with self.subTest(headers=fields):
                self.assertEqual(self.raw("/api/public/bootstrap", headers=fields, method="GET")[0], 400)
        self.assertEqual(self.raw("/api/public/bootstrap", headers=[("Host", "127.0.0.1:1")], method="GET")[0], 403)

    def test_origin_validation_keeps_authorized_mutation_scoped(self):
        teacher = self.teacher()
        org = teacher.request("/api/organizations/garden-sun")[1]["organization"]
        body = json.dumps(org).encode()
        cookie = "; ".join(f"{item.name}={item.value}" for item in teacher.cookies)
        headers = [("Host", self.host), ("Content-Type", "application/json"), ("Content-Length", str(len(body))),
                   ("Cookie", cookie), ("X-CSRF-Token", teacher.csrf)]
        for origins in (["https://unrelated.invalid"], [self.base, self.base]):
            with self.subTest(origins=origins):
                fields = headers + [("Origin", value) for value in origins]
                self.assertEqual(self.raw("/api/organizations/garden-sun", body, fields, "PUT")[0], 403)
        self.assertEqual(self.raw("/api/organizations/garden-sun", body, headers + [("Origin", self.base)], "PUT")[0], 200)

    def test_surrogates_in_login_fields_and_json_keys_return_400(self):
        self.assertEqual(self.raw(body={**self.login_body(), "password": "\ud800"})[0], 400)
        self.assertEqual(self.raw(body={**self.login_body(), "unused": "\udfff"})[0], 400)
        self.assertEqual(self.raw(body={**self.login_body(), "\ud800": "unused"})[0], 400)
        self.assertEqual(Client(self.base).login("admin", "admin")[0], 200)

    def test_surrogate_profile_write_does_not_change_stored_data(self):
        teacher = self.teacher()
        original = teacher.request("/api/organizations/garden-sun")[1]["organization"]
        self.assertEqual(teacher.request("/api/organizations/garden-sun", "PUT", {**original, "descriptionKk": "\ud800"})[0], 400)
        self.assertEqual(teacher.request("/api/organizations/garden-sun")[1]["organization"], original)

    def test_deep_json_invalid_json_and_non_finite_values_do_not_abort_http(self):
        cases = [b"[" * 5000 + b"0" + b"]" * 5000, b'{"nested":' + b"[" * 40 + b"0" + b"]" * 40 + b"}",
                 b'{"invalid":NaN}', b'{"invalid":Infinity}', b'{"invalid":1e999}', b'{"unclosed":', b"\xff"]
        for payload in cases:
            with self.subTest(payload=payload[:30]):
                self.assertEqual(self.raw(body=payload)[0], 400)
        self.assertEqual(Client(self.base).request("/api/public/bootstrap")[0], 200)

    def test_malformed_request_targets_return_400(self):
        for method in ("GET", "POST"):
            for target in ("http://[bad", "http://127.0.0.1/api/login", "/api/session#fragment"):
                with self.subTest(target=target, method=method):
                    self.assertEqual(self.raw(target, b"{}", method=method)[0], 400)

    def test_ambiguous_or_incomplete_body_is_rejected_before_login(self):
        body = json.dumps(self.login_body()).encode()
        common = [("Host", self.host), ("Content-Type", "application/json")]
        headers = [common + [("Content-Length", str(len(body))), ("Content-Length", str(len(body)))],
                   common + [("Content-Length", str(len(body))), ("Transfer-Encoding", "chunked")],
                   common + [("Content-Length", str(len(body) + 10))]]
        for fields in headers:
            with self.subTest(headers=fields):
                self.assertEqual(self.raw(body=body, headers=fields)[0], 400)
        self.assertEqual(Client(self.base).request("/api/session")[1]["user"], None)

    def test_changing_usernames_does_not_bypass_login_rate_limit(self):
        statuses = [Client(self.base).login(f"unknown-{index}", "teacher", "IncorrectPassword")[0] for index in range(33)]
        self.assertEqual(statuses, [401] * 32 + [429])
        self.assertEqual(Client(self.base).login("admin", "admin")[0], 429)

    def test_additional_hosts_must_be_configured_explicitly(self):
        extra_server = portal.create_server(self.path, port=0, host="0.0.0.0", allowed_hosts=("explicit-demo.invalid",))
        try:
            self.assertIn("explicit-demo.invalid", extra_server.allowed_hosts)
            self.assertNotIn("rebinding.invalid", extra_server.allowed_hosts)
            self.assertNotIn("0.0.0.0", extra_server.allowed_hosts)
        finally:
            extra_server.server_close()

    def test_profile_patch_preserves_other_sections_and_rejects_forbidden_fields(self):
        teacher = self.teacher()
        original = teacher.request("/api/organizations/garden-sun")[1]["organization"]
        try:
            self.assertEqual(teacher.request("/api/organizations/garden-sun", "PATCH", {"phone": "+7 (000) 111-11-11"})[0], 200)
            self.assertEqual(teacher.request("/api/organizations/garden-sun", "PATCH", {"parentInfo": "Обновление другого раздела"})[0], 200)
            result = teacher.request("/api/organizations/garden-sun")[1]["organization"]
            self.assertEqual(result["phone"], "+7 (000) 111-11-11")
            self.assertEqual(result["parentInfo"], "Обновление другого раздела")
            for invalid in ({}, {"id": "school-24"}, {"name": None}, {"unexpected": "value"}):
                self.assertEqual(teacher.request("/api/organizations/garden-sun", "PATCH", invalid)[0], 400)
            self.assertEqual(teacher.request("/api/organizations/school-24", "PATCH", {"phone": "changed"})[0], 403)
            self.assertEqual(teacher.request("/api/organizations/garden-sun", "PATCH", {"phone": "changed"}, csrf=False)[0], 403)
            reader = Client(self.base)
            self.assertEqual(reader.login("student24", "student")[0], 200)
            self.assertEqual(reader.request("/api/organizations/school-24", "PATCH", {"phone": "changed"})[0], 403)
        finally:
            self.assertEqual(teacher.request("/api/organizations/garden-sun", "PUT", original)[0], 200)

    def test_concurrent_patches_keep_distinct_editor_changes(self):
        first = self.teacher()
        second = self.teacher()
        original = first.request("/api/organizations/garden-sun")[1]["organization"]
        barrier = threading.Barrier(2)
        def update(client, data):
            barrier.wait(timeout=5)
            return client.request("/api/organizations/garden-sun", "PATCH", data)[0]
        try:
            with ThreadPoolExecutor(max_workers=2) as executor:
                requests = [executor.submit(update, first, {"phone": "+7 (000) 222-22-22"}),
                            executor.submit(update, second, {"parentInfo": "Другой сотрудник изменил сведения"})]
                self.assertEqual([future.result() for future in requests], [200, 200])
            result = first.request("/api/organizations/garden-sun")[1]["organization"]
            self.assertEqual(result["phone"], "+7 (000) 222-22-22")
            self.assertEqual(result["parentInfo"], "Другой сотрудник изменил сведения")
        finally:
            self.assertEqual(first.request("/api/organizations/garden-sun", "PUT", original)[0], 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
