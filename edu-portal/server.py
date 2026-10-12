"""Local MVP: shared SQLite data, account sessions and organization access checks."""
from __future__ import annotations

from contextlib import contextmanager
import argparse
import base64
import binascii
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
from datetime import date
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, unquote

ROOT = Path(__file__).resolve().parent
DISTRICTS = ["Центральный", "Северный", "Южный", "Восточный", "Западный"]
TYPES = {"school": "Школа", "garden": "Детский сад", "extra": "Дополнительное образование"}
ORG_FIELDS = {"name", "type", "district", "address", "hours", "tag", "description", "email", "features",
              "phone", "nameKk", "descriptionKk", "addressKk", "parentInfo", "parentInfoKk", "routine", "routineKk",
              "program", "programKk", "hoursKk", "tagKk", "ageGroups", "featuresKk", "ageGroupsKk", "visibility"}
COOKIE = "edu_session"
PASSWORD_ROUNDS = 240_000
SESSION_SECONDS = 8 * 60 * 60
DEMO_PASSWORD = os.environ.get("EDU_DEMO_PASSWORD", "Demo2026!")
MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
DEMO_USERS = [
    ("student24", "Ученик школы № 24", "student", "school-24"),
    ("student7", "Ученик школы № 7", "student", "school-7"),
    ("teacher24", "Учитель школы № 24", "teacher", "school-24"),
    ("teacher7", "Учитель школы № 7", "teacher", "school-7"),
    ("teacher-garden", "Сотрудник детского сада", "teacher", "garden-sun"),
    ("admin", "Администратор области", "admin", None),
]


class ApiError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


def password_hash(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), PASSWORD_ROUNDS).hex()


def text_field(data, key, maximum, required=True):
    value = data.get(key, "")
    if not isinstance(value, str):
        raise ApiError(400, "Поля формы должны содержать текст.")
    value = value.strip()
    if len(value) > maximum or (required and not value):
        raise ApiError(400, "Заполните обязательные поля и проверьте длину текста.")
    return value


def validate_org(data):
    fields = {key: text_field(data, key, size, key != "email") for key, size in {
        "name": 100, "type": 20, "district": 30, "address": 140, "hours": 80,
        "tag": 40, "description": 1200, "email": 120,
    }.items()}
    if fields["type"] not in TYPES or fields["district"] not in DISTRICTS:
        raise ApiError(400, "Выберите тип организации и район из списка.")
    if fields["email"] and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", fields["email"]):
        raise ApiError(400, "Проверьте электронную почту.")
    features = data.get("features")
    if not isinstance(features, list) or not 1 <= len(features) <= 12:
        raise ApiError(400, "Добавьте от 1 до 12 направлений.")
    fields["features"] = [text_field({"feature": item}, "feature", 80) for item in features]
    for key, maximum in {"phone":40, "nameKk":100, "descriptionKk":1200, "addressKk":140,
                         "parentInfo":4000, "parentInfoKk":4000, "routine":4000, "routineKk":4000,
                         "program":4000, "programKk":4000, "hoursKk":80, "tagKk":40}.items():
        fields[key] = text_field(data, key, maximum, False)
    groups = data.get("ageGroups", [])
    if not isinstance(groups, list) or len(groups) > 8:
        raise ApiError(400, "Укажите не более восьми возрастных групп.")
    fields["ageGroups"] = [text_field({"value": group}, "value", 60) for group in groups]
    for key, maximum_items in [("featuresKk",12),("ageGroupsKk",8)]:
        values = data.get(key,[])
        if not isinstance(values,list) or len(values) > maximum_items:
            raise ApiError(400,"Проверьте количество пунктов казахской версии.")
        fields[key] = [text_field({"value":value},"value",80) for value in values]
    fields["visibility"] = data.get("visibility", "published")
    if fields["visibility"] not in ("draft", "published"):
        raise ApiError(400, "Выберите статус сайта.")
    return fields


def visible(data):
    return data.get("visibility", "published") == "published"


def published(data):
    return data.get("status", "published") == "published"


def validate_news(data):
    news = {key: text_field(data, key, size) for key, size in {"title":120, "summary":180, "body":5000, "category":30, "date":10}.items()}
    for key, size in {"titleKk":120, "summaryKk":180, "bodyKk":5000}.items():
        news[key] = text_field(data, key, size, False)
    news["status"] = data.get("status", "published")
    if news["status"] not in ("draft", "published", "archived"):
        raise ApiError(400, "Выберите статус материала.")
    if news["category"] not in ("События", "Кружки", "Родителям"):
        raise ApiError(400, "Выберите категорию из списка.")
    try:
        parsed = date.fromisoformat(news["date"])
        if not 2020 <= parsed.year <= 2100:
            raise ValueError()
        news["date"] = parsed.isoformat()
    except ValueError:
        raise ApiError(400, "Проверьте дату публикации.") from None
    news["art"] = "creative" if news["category"] == "Кружки" else "parents" if news["category"] == "Родителям" else "school"
    return news


class Database:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('student','teacher','admin')),
                    org_id TEXT REFERENCES organizations(id), salt TEXT NOT NULL, password_hash TEXT NOT NULL,
                    CHECK((role = 'admin' AND org_id IS NULL) OR (role != 'admin' AND org_id IS NOT NULL))
                );
                CREATE TABLE IF NOT EXISTS news (
                    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                    csrf TEXT NOT NULL, expires REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS news_organization ON news(org_id);
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
                    payload TEXT NOT NULL, file BLOB NOT NULL
                );
                CREATE INDEX IF NOT EXISTS documents_organization ON documents(org_id);
                CREATE TABLE IF NOT EXISTS audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, actor TEXT NOT NULL,
                    org_id TEXT, event TEXT NOT NULL, target TEXT NOT NULL
                );
            """)
            if not connection.execute("SELECT 1 FROM metadata WHERE key = 'initialized'").fetchone():
                seed = json.loads((ROOT / "seed.json").read_text(encoding="utf-8"))
                for org in seed["organizations"]:
                    connection.execute("INSERT INTO organizations VALUES (?,?)", (org["id"], json.dumps(org, ensure_ascii=False)))
                for news in seed["news"]:
                    connection.execute("INSERT INTO news VALUES (?,?,?)", (news["id"], news["orgId"], json.dumps(news, ensure_ascii=False)))
                for org in seed["organizations"]:
                    document = {"id":"doc-" + org["id"], "orgId":org["id"], "title":"Демонстрационная памятка",
                                "titleKk":"Демонстрациялық жадынама", "filename":"demo-information.txt",
                                "mime":"text/plain", "status":"published", "updated":date.today().isoformat()}
                    content = (org["name"] + "\nДемонстрационный документ. Не является официальным.\n"
                               "Демонстрациялық құжат. Ресми құжат емес.\n").encode("utf-8")
                    document["size"] = len(content)
                    connection.execute("INSERT INTO documents VALUES (?,?,?,?)", (document["id"],org["id"],json.dumps(document,ensure_ascii=False),content))
                for username, name, role, org_id in DEMO_USERS:
                    salt = secrets.token_hex(16)
                    connection.execute("INSERT INTO users VALUES (?,?,?,?,?,?,?)", (
                        secrets.token_hex(12), username, name, role, org_id, salt, password_hash(DEMO_PASSWORD, salt)
                    ))
                connection.execute("INSERT INTO metadata VALUES ('initialized','1')")

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            with connection:
                yield connection
        finally:
            connection.close()


def public_user(row):
    return {"id": row["id"], "username": row["username"], "name": row["name"], "role": row["role"], "orgId": row["org_id"]}


def check_org(user, org_id, write=False):
    if write and user["role"] == "student":
        raise ApiError(403, "У ученика нет права изменять данные организации.")
    if user["role"] != "admin" and user["orgId"] != org_id:
        raise ApiError(403, "Эта организация недоступна вашему аккаунту.")


class PortalHandler(BaseHTTPRequestHandler):
    server_version = "EducationMVP"
    failures = {}
    failure_lock = threading.Lock()

    def setup(self):
        super().setup()
        self.connection.settimeout(20)

    def log_message(self, format, *args):
        # Never log cookies, passwords, request bodies or user account names.
        if self.path.startswith("/api/"):
            return
        super().log_message(format, *args)

    def headers_common(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")

    def send_json(self, data, status=200, cookie=None):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.headers_common()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(payload)

    def read_json(self, maximum=65536):
        if self.headers.get("Content-Type", "").split(";")[0].lower() != "application/json":
            raise ApiError(415, "Ожидается JSON-запрос.")
        origins = self.headers.get_all("Origin", [])
        host = self.headers.get("Host", "")
        if len(origins) > 1 or (origins and origins[0] not in ("http://" + host, "https://" + host)):
            raise ApiError(403, "Запрос с другого сайта запрещён.")
        sizes = self.headers.get_all("Content-Length", [])
        if len(sizes) != 1 or self.headers.get_all("Transfer-Encoding"):
            raise ApiError(400, "Проверьте заголовки размера запроса.")
        try:
            size = int(sizes[0])
        except ValueError:
            raise ApiError(400, "Некорректный размер запроса.") from None
        if not 0 < size <= maximum:
            raise ApiError(413, "Некорректный размер запроса.")
        try:
            payload = self.rfile.read(size)
            if len(payload) != size:
                raise ValueError("Incomplete request body")
            data = json.loads(payload)
        except (ValueError, UnicodeDecodeError, RecursionError, TimeoutError):
            raise ApiError(400, "Некорректные данные запроса.") from None
        if not isinstance(data, dict):
            raise ApiError(400, "Ожидается объект JSON.")
        # Validate every string, including optional fields, before SQLite/UTF-8 encoding.
        pending = [(data, 0)]
        while pending:
            value, depth = pending.pop()
            if depth > 32:
                raise ApiError(400, "Слишком сложная структура JSON.")
            if isinstance(value, str):
                try:
                    value.encode("utf-8")
                except UnicodeEncodeError:
                    raise ApiError(400, "Текст содержит некорректный символ Unicode.") from None
            elif isinstance(value, dict):
                pending.extend((item, depth + 1) for item in value.keys())
                pending.extend((item, depth + 1) for item in value.values())
            elif isinstance(value, list):
                pending.extend((item, depth + 1) for item in value)
            elif isinstance(value, float) and not math.isfinite(value):
                raise ApiError(400, "JSON не должен содержать бесконечность или NaN.")
        return data

    def request_path(self):
        # Local endpoints accept origin-form request targets and configured hosts only.
        # Checking Host on reads as well as writes blocks DNS rebinding to localhost.
        if not self.path.startswith("/") or any(ord(char) < 32 for char in self.path):
            raise ApiError(400, "Некорректный адрес запроса.")
        try:
            target = urlsplit(self.path)
            if target.netloc or target.scheme or target.fragment:
                raise ValueError("Invalid request target")
        except ValueError:
            raise ApiError(400, "Некорректный адрес запроса.") from None
        hosts = self.headers.get_all("Host", [])
        if len(hosts) != 1 or not hosts[0] or any(char.isspace() for char in hosts[0]):
            raise ApiError(400, "Укажите один корректный заголовок Host.")
        try:
            authority = urlsplit("http://" + hosts[0])
            if (authority.username is not None or authority.password is not None or authority.path or
                    authority.query or authority.fragment or not authority.hostname):
                raise ValueError("Invalid Host")
            hostname = authority.hostname.lower().rstrip(".")
            port = authority.port or 80
        except ValueError:
            raise ApiError(400, "Некорректный заголовок Host.") from None
        if hostname not in self.server.allowed_hosts or port != self.server.server_port:
            raise ApiError(403, "Этот адрес сервера не разрешён.")
        return target.path

    def session(self, required=True, mutation=False):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            token = cookie[COOKIE].value if COOKIE in cookie else ""
        except Exception:
            token = ""
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with self.server.database.connect() as connection:
            row = connection.execute("""SELECT u.*, s.csrf, s.expires FROM sessions s
                JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?""", (token_hash, time.time())).fetchone()
        if not row:
            if required:
                raise ApiError(401, "Войдите в свой аккаунт.")
            return None, None, token_hash
        if mutation:
            token = self.headers.get("X-CSRF-Token", "")
            if not re.fullmatch(r"[A-Za-z0-9_-]{20,100}", token) or not hmac.compare_digest(token, row["csrf"]):
                raise ApiError(403, "Обновите страницу и повторите действие.")
        return public_user(row), row["csrf"], token_hash

    def cookie(self, token="", logout=False):
        secure = "; Secure" if self.server.secure_cookies else ""
        return f"{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={0 if logout else SESSION_SECONDS}{secure}"

    @staticmethod
    def require_admin(user):
        if user["role"] != "admin":
            raise ApiError(403, "Этот раздел доступен только администратору.")

    def organizations(self, user):
        with self.server.database.connect() as connection:
            if user is None or user["role"] == "admin":
                rows = connection.execute("SELECT payload FROM organizations ORDER BY rowid").fetchall()
            else:
                rows = connection.execute("SELECT payload FROM organizations WHERE id=?", (user["orgId"],)).fetchall()
        organizations = [json.loads(row["payload"]) for row in rows]
        return [org for org in organizations if visible(org)] if user is None else organizations

    def news(self, user):
        with self.server.database.connect() as connection:
            all_orgs = user is None or user["role"] == "admin"
            rows = connection.execute("SELECT payload FROM news" if all_orgs else "SELECT payload FROM news WHERE org_id=?",
                                      () if all_orgs else (user["orgId"],)).fetchall()
        news = [json.loads(row["payload"]) for row in rows]
        if user is None:
            organization_ids = {org["id"] for org in self.organizations(None)}
            news = [item for item in news if published(item) and item["orgId"] in organization_ids]
        elif user["role"] == "student":
            news = [item for item in news if published(item)]
        return sorted(news, key=lambda item: item["date"], reverse=True)

    def organization(self, user, org_id):
        if user is not None:
            check_org(user, org_id)
        with self.server.database.connect() as connection:
            row = connection.execute("SELECT payload FROM organizations WHERE id=?", (org_id,)).fetchone()
        if not row:
            raise ApiError(404, "Организация не найдена.")
        org = json.loads(row["payload"])
        if user is None and not visible(org):
            raise ApiError(404, "Организация ещё не опубликована.")
        return org

    def documents(self, user):
        with self.server.database.connect() as connection:
            all_orgs = user is None or user["role"] == "admin"
            rows = connection.execute("SELECT payload FROM documents" if all_orgs else "SELECT payload FROM documents WHERE org_id=?",
                                      () if all_orgs else (user["orgId"],)).fetchall()
        documents = [json.loads(row["payload"]) for row in rows]
        if user is None:
            allowed = {org["id"] for org in self.organizations(None)}
            documents = [item for item in documents if published(item) and item["orgId"] in allowed]
        elif user["role"] == "student":
            documents = [item for item in documents if published(item)]
        return documents

    def audit(self, user, event, target, org_id=None):
        with self.server.database.connect() as connection:
            connection.execute("INSERT INTO audit(time,actor,org_id,event,target) VALUES (?,?,?,?,?)",
                               (time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()), user["name"], org_id, event, target))

    def quality(self, org):
        checks = {key:bool(org.get(key)) for key in ["name","nameKk","description","descriptionKk","address","addressKk","phone","email","parentInfo","parentInfoKk"]}
        if org["type"] == "garden":
            checks.update({key:bool(org.get(key)) for key in ["ageGroups","ageGroupsKk","routine","routineKk"]})
        else:
            checks.update({key:bool(org.get(key)) for key in ["program","programKk"]})
        with self.server.database.connect() as connection:
            for table in ["news","documents"]:
                rows = connection.execute(f"SELECT payload FROM {table} WHERE org_id=?",(org["id"],)).fetchall()
                checks[table] = any(published(json.loads(row["payload"])) for row in rows)
        return {"id":org["id"], "percent":round(sum(checks.values())/len(checks)*100),"checks":checks}

    def download(self, user, document_id):
        with self.server.database.connect() as connection:
            row = connection.execute("SELECT * FROM documents WHERE id=?",(document_id,)).fetchone()
        if not row:
            raise ApiError(404,"Документ не найден.")
        metadata = json.loads(row["payload"])
        self.organization(user,row["org_id"])
        if (user is None or user["role"] == "student") and not published(metadata):
            raise ApiError(404,"Документ не опубликован.")
        self.send_response(200)
        self.headers_common()
        self.send_header("Content-Type",metadata["mime"])
        self.send_header("Content-Disposition",f'attachment; filename="document-{document_id}.{metadata["filename"].rsplit(".",1)[-1]}"')
        self.send_header("Content-Length",str(len(row["file"])))
        self.end_headers()
        self.wfile.write(row["file"])

    def do_GET(self):
        try:
            path = self.request_path()
            if not path.startswith("/api/"):
                return self.static(path)
            if path == "/api/session":
                user, csrf, _ = self.session(required=False)
                return self.send_json({"user": user, "csrf": csrf})
            if path == "/api/public/bootstrap":
                return self.send_json({"organizations":self.organizations(None),"news":self.news(None),"documents":self.documents(None),"demo":True,"demoPasswordDefault":DEMO_PASSWORD == "Demo2026!"})
            match = re.fullmatch(r"/api/public/organizations/([\w-]+)", path)
            if match:
                return self.send_json({"organization":self.organization(None,match[1])})
            match = re.fullmatch(r"/api/public/news/([\w-]+)", path)
            if match:
                items = [item for item in self.news(None) if item["id"] == match[1]]
                if not items:
                    raise ApiError(404,"Новость не опубликована.")
                return self.send_json({"news":items[0]})
            match = re.fullmatch(r"/api/public/documents/([\w-]+)",path)
            if match:
                return self.download(None,match[1])
            user, csrf, _ = self.session()
            if path == "/api/bootstrap":
                orgs = self.organizations(user)
                return self.send_json({"user":user,"csrf":csrf,"organizations":orgs,"news":self.news(user),"documents":self.documents(user),
                                       "quality":[] if user["role"] == "student" else [self.quality(org) for org in orgs]})
            if path == "/api/organizations":
                return self.send_json({"organizations": self.organizations(user)})
            if path == "/api/news":
                return self.send_json({"news": self.news(user)})
            if path == "/api/documents":
                return self.send_json({"documents":self.documents(user)})
            if path == "/api/audit":
                if user["role"] == "student":
                    raise ApiError(403,"Журнал доступен сотрудникам.")
                with self.server.database.connect() as connection:
                    rows = connection.execute("SELECT time,actor,event,target,org_id FROM audit ORDER BY id DESC LIMIT 100" if user["role"] == "admin" else
                                              "SELECT time,actor,event,target,org_id FROM audit WHERE org_id=? ORDER BY id DESC LIMIT 100",
                                              () if user["role"] == "admin" else (user["orgId"],)).fetchall()
                return self.send_json({"audit":[dict(row) for row in rows]})
            match = re.fullmatch(r"/api/documents/([\w-]+)",path)
            if match:
                return self.download(user,match[1])
            if path == "/api/users":
                self.require_admin(user)
                with self.server.database.connect() as connection:
                    rows = connection.execute("SELECT * FROM users ORDER BY rowid").fetchall()
                return self.send_json({"users": [public_user(row) for row in rows]})
            match = re.fullmatch(r"/api/organizations/([\w-]+)(?:/documents/(about|admission|schedule))?", path)
            if match:
                org = self.organization(user, match[1])
                return self.document(org, match[2]) if match[2] else self.send_json({"organization": org})
            match = re.fullmatch(r"/api/news/([\w-]+)", path)
            if match:
                with self.server.database.connect() as connection:
                    row = connection.execute("SELECT * FROM news WHERE id=?", (match[1],)).fetchone()
                if not row:
                    raise ApiError(404, "Новость не найдена.")
                check_org(user, row["org_id"])
                item = json.loads(row["payload"])
                if user["role"] == "student" and not published(item):
                    raise ApiError(404,"Новость не опубликована.")
                return self.send_json({"news":item})
            raise ApiError(404, "Страница не найдена.")
        except ApiError as error:
            self.send_json({"error": error.message}, error.status)
        except (sqlite3.Error, OSError):
            self.send_json({"error": "Не удалось прочитать данные. Повторите позже."}, 500)

    def static(self, path):
        # Only the public asset allowlist is served; seed, SQLite and Python source stay server-side.
        files = {"/": ("index.html", "text/html"), "/index.html": ("index.html", "text/html"),
                 "/app.js": ("app.js", "text/javascript"), "/styles.css": ("styles.css", "text/css"),
                 "/roles.css": ("roles.css", "text/css"),
                 "/mvp.css": ("mvp.css", "text/css"),
                 "/campus.svg": ("campus.svg", "image/svg+xml"), "/favicon.svg": ("favicon.svg", "image/svg+xml")}
        if unquote(path) not in files:
            self.send_error(404)
            return
        filename, content_type = files[unquote(path)]
        payload = (ROOT / "dist" / filename).read_bytes()
        self.send_response(200)
        self.headers_common()
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def document(self, org, kind):
        title = "ДЕМОНСТРАЦИОННЫЙ ДОКУМЕНТ\nНе является официальным документом.\n\n"
        if kind == "about":
            body = f"{org['name']}\nРайон: {org['district']}\nАдрес: {org['address']}\n\n{org['description']}"
        elif kind == "schedule":
            body = f"{org['name']}\nПример режима работы: {org['hours']}\nУточните актуальное расписание у организации."
        else:
            body = f"{org['name']}\n\nУточните свободные места, программы, расписание, перечень документов и сроки у организации.\nПодача заявлений через MVP не подключена."
        payload = ("\ufeff" + title + body).encode("utf-8")
        self.send_response(200)
        self.headers_common()
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{org["id"]}-{kind}-demo.txt"')
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        self.mutate("POST")

    def do_PUT(self):
        self.mutate("PUT")

    def do_PATCH(self):
        self.mutate("PATCH")

    def do_DELETE(self):
        self.mutate("DELETE")

    def mutate(self, method):
        try:
            path = self.request_path()
            if path == "/api/login" and method == "POST":
                return self.login(self.read_json())
            user, _, token_hash = self.session(mutation=True)
            data = self.read_json(12 * 1024 * 1024 if path == "/api/documents" and method == "POST" else 65536)
            if path == "/api/logout" and method == "POST":
                with self.server.database.connect() as connection:
                    connection.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))
                return self.send_json({"ok": True}, cookie=self.cookie(logout=True))
            if path == "/api/organizations" and method == "POST":
                self.require_admin(user)
                org = validate_org({"visibility":"draft", **data})
                org["id"] = "org-" + secrets.token_hex(8)
                with self.server.database.connect() as connection:
                    connection.execute("INSERT INTO organizations VALUES (?,?)", (org["id"], json.dumps(org, ensure_ascii=False)))
                self.audit(user,"organization_created",org["name"],org["id"])
                return self.send_json({"organization": org}, 201)
            match = re.fullmatch(r"/api/organizations/([\w-]+)", path)
            if match and method in ("PUT", "PATCH"):
                check_org(user, match[1], write=True)
                if method == "PATCH" and (not data or data.keys() - ORG_FIELDS):
                    raise ApiError(400, "Передайте только изменённые поля организации.")
                with self.server.database.connect() as connection:
                    # Serialize read/merge/write so distinct form sections do not overwrite one another.
                    connection.execute("BEGIN IMMEDIATE")
                    row = connection.execute("SELECT payload FROM organizations WHERE id=?", (match[1],)).fetchone()
                    if not row:
                        raise ApiError(404, "Организация не найдена.")
                    values = {**json.loads(row["payload"]), **data} if method == "PATCH" else data
                    org = {**validate_org(values), "id": match[1]}
                    connection.execute("UPDATE organizations SET payload=? WHERE id=?", (json.dumps(org, ensure_ascii=False), org["id"]))
                self.audit(user,"organization_updated",org["name"],org["id"])
                return self.send_json({"organization": org})
            if path == "/api/news" and method == "POST":
                org_id = text_field(data, "orgId", 80)
                check_org(user, org_id, write=True)
                self.organization(user, org_id)
                news = validate_news(data)
                news.update(id="news-" + secrets.token_hex(8), orgId=org_id)
                with self.server.database.connect() as connection:
                    connection.execute("INSERT INTO news VALUES (?,?,?)", (news["id"], org_id, json.dumps(news, ensure_ascii=False)))
                self.audit(user,"news_" + news["status"],news["title"],org_id)
                return self.send_json({"news": news}, 201)
            match = re.fullmatch(r"/api/news/([\w-]+)", path)
            if match and method in ("PUT","DELETE"):
                with self.server.database.connect() as connection:
                    row = connection.execute("SELECT * FROM news WHERE id=?", (match[1],)).fetchone()
                    if not row:
                        raise ApiError(404, "Новость не найдена.")
                    check_org(user, row["org_id"], write=True)
                    news = json.loads(row["payload"]) if method == "DELETE" else validate_news(data)
                    if method == "DELETE":
                        news["status"] = "archived"
                    news.update(id=match[1],orgId=row["org_id"])
                    connection.execute("UPDATE news SET payload=? WHERE id=?",(json.dumps(news,ensure_ascii=False),match[1]))
                self.audit(user,"news_" + news.get("status","published"),news["title"],row["org_id"])
                return self.send_json({"ok":True,"news":news})
            if path == "/api/documents" and method == "POST":
                org_id = text_field(data,"orgId",80)
                check_org(user,org_id,write=True)
                self.organization(user,org_id)
                title = text_field(data,"title",120)
                title_kk = text_field(data,"titleKk",120,False)
                status = data.get("status","draft")
                if status not in ("draft","published","archived"):
                    raise ApiError(400,"Выберите статус документа.")
                filename = re.split(r"[\\/]",text_field(data,"filename",160))[-1]
                extension = filename.rsplit(".",1)[-1].lower()
                if extension not in ("pdf","txt"):
                    raise ApiError(400,"Разрешены PDF и TXT.")
                encoded = text_field(data,"fileBase64",12 * 1024 * 1024)
                try:
                    content = base64.b64decode(encoded,validate=True)
                except (binascii.Error,ValueError):
                    raise ApiError(400,"Некорректное содержимое файла.") from None
                if not 0 < len(content) <= MAX_DOCUMENT_BYTES:
                    raise ApiError(400,"Размер файла: от 1 байта до 8 МБ.")
                if extension == "pdf" and not content.startswith(b"%PDF-"):
                    raise ApiError(400,"Файл не является PDF.")
                if extension == "txt":
                    try:
                        content.decode("utf-8-sig")
                    except UnicodeDecodeError:
                        raise ApiError(400,"TXT должен быть в кодировке UTF-8.") from None
                document = {"id":"doc-" + secrets.token_hex(8),"orgId":org_id,"title":title,"titleKk":title_kk,
                            "filename":filename,"mime":"application/pdf" if extension == "pdf" else "text/plain",
                            "size":len(content),"status":status,"updated":date.today().isoformat()}
                with self.server.database.connect() as connection:
                    connection.execute("INSERT INTO documents VALUES (?,?,?,?)",(document["id"],org_id,json.dumps(document,ensure_ascii=False),content))
                self.audit(user,"document_" + status,title,org_id)
                return self.send_json({"document":document},201)
            match = re.fullmatch(r"/api/documents/([\w-]+)",path)
            if match and method in ("PUT","DELETE"):
                with self.server.database.connect() as connection:
                    row = connection.execute("SELECT * FROM documents WHERE id=?",(match[1],)).fetchone()
                    if not row:
                        raise ApiError(404,"Документ не найден.")
                    check_org(user,row["org_id"],write=True)
                    document = json.loads(row["payload"])
                    document["status"] = "archived" if method == "DELETE" else data.get("status",document["status"])
                    if document["status"] not in ("draft","published","archived"):
                        raise ApiError(400,"Выберите статус документа.")
                    if method == "PUT":
                        document["title"] = text_field(data,"title",120)
                        document["titleKk"] = text_field(data,"titleKk",120,False)
                    document["updated"] = date.today().isoformat()
                    connection.execute("UPDATE documents SET payload=? WHERE id=?",(json.dumps(document,ensure_ascii=False),match[1]))
                self.audit(user,"document_" + document["status"],document["title"],row["org_id"])
                return self.send_json({"document":document,"ok":True})
            if path == "/api/users" and method == "POST":
                self.require_admin(user)
                fields = self.validate_user(data)
                username = text_field(data, "username", 40)
                password = text_field(data, "password", 128)
                if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_.-]{2,39}", username) or len(password) < 8:
                    raise ApiError(400, "Логин: 3–40 латинских символов. Пароль: минимум 8 символов.")
                salt = secrets.token_hex(16)
                user_id = secrets.token_hex(12)
                try:
                    with self.server.database.connect() as connection:
                        connection.execute("INSERT INTO users VALUES (?,?,?,?,?,?,?)", (user_id, username, fields["name"], fields["role"], fields["orgId"], salt, password_hash(password, salt)))
                        row = connection.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
                except sqlite3.IntegrityError:
                    raise ApiError(409, "Этот логин уже занят.") from None
                self.audit(user,"user_created",fields["name"],fields["orgId"])
                return self.send_json({"user": public_user(row)}, 201)
            match = re.fullmatch(r"/api/users/([\w-]+)", path)
            if match and method == "PUT":
                self.require_admin(user)
                fields = self.validate_user(data)
                with self.server.database.connect() as connection:
                    row = connection.execute("SELECT role FROM users WHERE id=?", (match[1],)).fetchone()
                    if not row:
                        raise ApiError(404, "Аккаунт не найден.")
                    if row["role"] == "admin":
                        raise ApiError(403, "Изменение административного аккаунта в MVP недоступно.")
                    connection.execute("UPDATE users SET name=?, role=?, org_id=? WHERE id=?", (fields["name"], fields["role"], fields["orgId"], match[1]))
                    connection.execute("DELETE FROM sessions WHERE user_id=?", (match[1],))
                    updated = connection.execute("SELECT * FROM users WHERE id=?", (match[1],)).fetchone()
                self.audit(user,"user_assigned",fields["name"],fields["orgId"])
                return self.send_json({"user": public_user(updated)})
            raise ApiError(404, "Действие не найдено.")
        except ApiError as error:
            self.send_json({"error": error.message}, error.status)
        except (sqlite3.Error, OSError):
            self.send_json({"error": "Не удалось сохранить данные. Повторите позже."}, 500)

    def validate_user(self, data):
        fields = {key: text_field(data, key, size) for key, size in {"name": 80, "role": 20, "orgId": 80}.items()}
        if fields["role"] not in ("student", "teacher"):
            raise ApiError(400, "Выберите роль ученика или учителя.")
        with self.server.database.connect() as connection:
            exists = connection.execute("SELECT 1 FROM organizations WHERE id=?", (fields["orgId"],)).fetchone()
        if not exists:
            raise ApiError(400, "Выберите существующую организацию.")
        return fields

    def login(self, data):
        username = text_field(data, "username", 40).lower()
        password = text_field(data, "password", 128)
        role = text_field(data, "role", 20)
        key = (self.client_address[0], username)
        address_key = (self.client_address[0], None)
        now = time.time()
        with self.failure_lock:
            type(self).failures = {item: timestamps for item, timestamps in type(self).failures.items() if timestamps and timestamps[-1] > now - 300}
            recent = [stamp for stamp in self.failures.get(key, []) if stamp > now - 60]
            address_recent = [stamp for stamp in self.failures.get(address_key, []) if stamp > now - 60]
            if len(recent) >= 8 or len(address_recent) >= 32:
                raise ApiError(429, "Слишком много попыток. Повторите через минуту.")
            # Reserve the attempt atomically before hashing. Concurrent requests cannot overwrite it.
            self.failures[key] = recent + [now]
            self.failures[address_key] = address_recent + [now]
        with self.server.database.connect() as connection:
            row = connection.execute("SELECT * FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone()
            candidate = password_hash(password, row["salt"] if row else "00" * 16)
            valid_password = hmac.compare_digest(candidate, row["password_hash"] if row else "00" * 32)
            if not row or not valid_password or row["role"] != role:
                raise ApiError(401, "Проверьте логин, пароль и выбранную роль.")
            token = secrets.token_urlsafe(32)
            csrf = secrets.token_urlsafe(24)
            connection.execute("DELETE FROM sessions WHERE expires<=?", (now,))
            connection.execute("INSERT INTO sessions VALUES (?,?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), row["id"], csrf, now + SESSION_SECONDS))
        with self.failure_lock:
            self.failures.pop(key, None)
        self.send_json({"user": public_user(row), "csrf": csrf}, cookie=self.cookie(token))


def create_server(database_path, host="127.0.0.1", port=4173, secure_cookies=False, allowed_hosts=()):
    database = Database(database_path)
    server = ThreadingHTTPServer((host, port), PortalHandler)
    server.database = database
    server.secure_cookies = secure_cookies
    server.allowed_hosts = {"127.0.0.1", "localhost", "::1"}
    if host not in ("0.0.0.0", "::", ""):
        server.allowed_hosts.add(host.lower().rstrip("."))
    server.allowed_hosts.update(value.lower().rstrip(".") for value in allowed_hosts)
    server.daemon_threads = True
    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Портал образования — сервер MVP")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--allowed-host", action="append", default=[], help="Дополнительное имя сервера или IP без порта; можно указать несколько раз")
    parser.add_argument("--data-dir", default=os.environ.get("EDU_DATA_DIR", str(ROOT / "data")))
    parser.add_argument("--secure-cookies", action="store_true", default=os.environ.get("EDU_SECURE_COOKIES") == "1")
    args = parser.parse_args()
    server = create_server(Path(args.data_dir) / "edu.sqlite3", args.host, args.port, args.secure_cookies, args.allowed_host)
    print(f"Education portal: http://{args.host}:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
