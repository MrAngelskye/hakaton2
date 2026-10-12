"""HTTP integration tests: authentication, organization isolation and administrator access."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import secrets
import unittest
from http.cookiejar import CookieJar
from urllib.error import HTTPError
from urllib.request import build_opener, HTTPCookieProcessor, Request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("portal_server", ROOT / "server.py")
portal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portal)


class Client:
    def __init__(self, base):
        self.base = base
        self.cookies = CookieJar()
        self.opener = build_opener(HTTPCookieProcessor(self.cookies))
        self.csrf = ""

    def request(self, path, method="GET", body=None, csrf=True):
        headers = {"Content-Type": "application/json"}
        if method != "GET" and csrf:
            headers["X-CSRF-Token"] = self.csrf
        request = Request(self.base + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
        try:
            response = self.opener.open(request)
        except HTTPError as error:
            response = error
        with response:
            payload = response.read().decode("utf-8-sig")
            data = json.loads(payload) if "application/json" in response.headers.get("Content-Type", "") else payload
            return response.status, data

    def login(self, username, role, password="Demo2026!"):
        status, data = self.request("/api/login", "POST", {"username": username, "password": password, "role": role})
        if status == 200:
            self.csrf = data["csrf"]
        return status, data


class AccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        test_root = Path(os.environ.get('EDU_TEST_DIR', tempfile.gettempdir())).resolve()
        test_root.mkdir(parents=True, exist_ok=True)
        cls.test_root = test_root
        cls.database_path = test_root / ('test-' + secrets.token_hex(8) + '.sqlite3')
        cls.server = portal.create_server(cls.database_path, port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        for suffix in ('', '-wal', '-shm'):
            temporary_file = Path(str(cls.database_path) + suffix).resolve()
            if temporary_file.parent != cls.test_root:
                raise RuntimeError('Temporary database is outside the intended test directory.')
            temporary_file.unlink(missing_ok=True)

    def client(self, username, role):
        client = Client(self.base)
        self.assertEqual(client.login(username, role)[0], 200)
        return client

    def test_anonymous_and_static_data_do_not_disclose_catalog(self):
        client = Client(self.base)
        self.assertEqual(client.request("/api/bootstrap")[0], 401)
        self.assertEqual(client.request("/api/organizations")[0], 401)
        for path in ("/seed.json", "/server.py", "/data/edu.sqlite3", "/../seed.json", "/%2e%2e/seed.json"):
            self.assertEqual(client.request(path)[0], 404)
        status, javascript = client.request("/app.js")
        self.assertEqual(status, 200)
        self.assertNotIn("seedOrganizations", javascript)
        self.assertNotIn("Детский сад «Радуга»", javascript)

    def test_selected_role_cannot_elevate_an_account(self):
        client = Client(self.base)
        self.assertEqual(client.login("student24", "admin")[0], 401)
        self.assertEqual(client.request("/api/session")[1]["user"], None)
        self.assertEqual(client.login("teacher24", "teacher", "incorrect")[0], 401)

    def test_student_gets_only_assigned_school_and_its_news(self):
        student = self.client("student24", "student")
        status, data = student.request("/api/bootstrap")
        self.assertEqual(status, 200)
        self.assertEqual([org["id"] for org in data["organizations"]], ["school-24"])
        self.assertTrue(all(news["orgId"] == "school-24" for news in data["news"]))
        self.assertNotIn("users", data)
        self.assertEqual(student.request("/api/organizations/school-7")[0], 403)
        self.assertEqual(student.request("/api/news/parents-meeting")[0], 403)
        self.assertEqual(student.request("/api/organizations/garden-sun/documents/about")[0], 403)
        self.assertEqual(student.request("/api/organizations/school-24/documents/about")[0], 200)
        self.assertEqual(student.request("/api/users")[0], 403)

    def test_second_school_and_kindergarten_have_separate_scopes(self):
        for username, role, org_id in (("student7", "student", "school-7"), ("teacher7", "teacher", "school-7"), ("teacher-garden", "teacher", "garden-sun")):
            client = self.client(username, role)
            data = client.request("/api/bootstrap")[1]
            self.assertEqual([org["id"] for org in data["organizations"]], [org_id])
            self.assertEqual(client.request("/api/organizations/school-24")[0], 403)

    def test_student_cannot_write_even_with_valid_session_and_csrf(self):
        student = self.client("student24", "student")
        org = student.request("/api/organizations/school-24")[1]["organization"]
        self.assertEqual(student.request("/api/organizations/school-24", "PUT", org)[0], 403)
        self.assertEqual(student.request("/api/organizations", "POST", org)[0], 403)
        self.assertEqual(student.request("/api/news", "POST", {"orgId":"school-24"})[0], 403)
        self.assertEqual(student.request("/api/users", "POST", {})[0], 403)

    def test_teacher_writes_own_school_but_cannot_cross_organization(self):
        teacher = self.client("teacher24", "teacher")
        org = teacher.request("/api/organizations/school-24")[1]["organization"]
        changed = {**org, "description":"Обновление описания для проверки общей базы."}
        self.assertEqual(teacher.request("/api/organizations/school-7", "PUT", changed)[0], 403)
        self.assertEqual(teacher.request("/api/organizations/school-24", "PUT", changed)[0], 200)
        student = self.client("student24", "student")
        self.assertEqual(student.request("/api/organizations/school-24")[1]["organization"]["description"], changed["description"])
        self.assertEqual(teacher.request("/api/users")[0], 403)
        self.assertEqual(teacher.request("/api/organizations", "POST", changed)[0], 403)
        self.assertEqual(teacher.request("/api/news", "POST", {"orgId":"school-7"})[0], 403)
        self.assertEqual(teacher.request("/api/news/parents-meeting", "DELETE", {})[0], 403)
        self.assertEqual(teacher.request("/api/organizations/school-24", "PUT", org)[0], 200)

    def test_news_visible_only_in_own_school(self):
        teacher = self.client("teacher24", "teacher")
        news = {"orgId":"school-24", "title":"Тест изоляции новости", "summary":"Тест", "body":"Тестовое сообщение", "category":"События", "date":"2026-10-11"}
        status, data = teacher.request("/api/news", "POST", news)
        self.assertEqual(status, 201)
        news_id = data["news"]["id"]
        student = self.client("student24", "student")
        other = self.client("student7", "student")
        self.assertEqual(student.request("/api/news/" + news_id)[0], 200)
        self.assertEqual(other.request("/api/news/" + news_id)[0], 403)
        self.assertEqual(student.request("/api/news/" + news_id, "DELETE", {})[0], 403)
        self.assertEqual(teacher.request("/api/news/" + news_id, "DELETE", {})[0], 200)

    def test_admin_adds_organization_account_and_rebinds_session(self):
        admin = self.client("admin", "admin")
        orgs = admin.request("/api/organizations")[1]["organizations"]
        self.assertGreaterEqual(len(orgs), 12)
        new_org = {**orgs[0], "name":"Тестовая организация администратора"}
        status, response = admin.request("/api/organizations", "POST", new_org)
        self.assertEqual(status, 201)
        org_id = response["organization"]["id"]
        user = {"name":"Тестовый ученик", "username":"access-test-student", "password":"TestPassword2026", "role":"student", "orgId":org_id}
        status, response = admin.request("/api/users", "POST", user)
        self.assertEqual(status, 201)
        user_id = response["user"]["id"]
        self.assertNotIn("password", response["user"])
        self.assertNotIn("password_hash", response["user"])
        student = Client(self.base)
        self.assertEqual(student.login(user["username"], "student", user["password"])[0], 200)
        self.assertEqual(student.request("/api/bootstrap")[1]["organizations"][0]["id"], org_id)
        status, _ = admin.request("/api/users/" + user_id, "PUT", {**user,"orgId":"school-7"})
        self.assertEqual(status, 200)
        self.assertEqual(student.request("/api/bootstrap")[0], 401)
        self.assertEqual(student.login(user["username"], "student", user["password"])[0], 200)
        self.assertEqual(student.request("/api/bootstrap")[1]["organizations"][0]["id"], "school-7")
        self.assertEqual(student.request("/api/organizations/" + org_id)[0], 403)
        reloaded_database = portal.Database(self.database_path)
        with reloaded_database.connect() as connection:
            self.assertIsNotNone(connection.execute("SELECT id FROM organizations WHERE id=?", (org_id,)).fetchone())

    def test_csrf_required_and_logout_invalidates_session(self):
        teacher = self.client("teacher24", "teacher")
        org = teacher.request("/api/organizations/school-24")[1]["organization"]
        self.assertEqual(teacher.request("/api/organizations/school-24", "PUT", org, csrf=False)[0], 403)
        cookie = next(iter(teacher.cookies))
        self.assertIn("HttpOnly", cookie._rest)
        self.assertEqual(cookie._rest["SameSite"], "Lax")
        self.assertEqual(teacher.request("/api/logout", "POST", {})[0], 200)
        self.assertEqual(teacher.request("/api/bootstrap")[0], 401)
        self.assertEqual(teacher.request("/api/session")[1]["user"], None)


if __name__ == "__main__":
    unittest.main(verbosity=2)
