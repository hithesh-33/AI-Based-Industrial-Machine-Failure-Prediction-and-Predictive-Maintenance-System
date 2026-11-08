from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from functools import wraps
import json
import math
import os
from pathlib import Path
import re
import secrets
import sqlite3
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import joblib
import numpy as np
from flask import Flask, g, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash


ROOT = Path(__file__).resolve().parents[1]
INSTANCE_DIR = ROOT / "instance"
INSTANCE_DIR.mkdir(exist_ok=True)
DATABASE_PATH = Path(os.environ.get("FORGESIGHT_DATABASE", INSTANCE_DIR / "forgesight.sqlite3"))
DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
MODEL_PATH = ROOT / "models" / "failure_model.joblib"
app = Flask(__name__, template_folder="../frontend/templates", static_folder="../frontend/static")

FEATURES = ["Temperature", "Vibration", "RotationalSpeed", "Pressure", "MachineLoad"]
MACHINES = [
    {"id": "MCH-001", "name": "CNC Milling Unit", "line": "Production Line A", "base": [69, 3.2, 1480, 6.1, 72], "last": "2026-10-29", "next": "2026-11-07", "hours": 1260},
    {"id": "MCH-002", "name": "Hydraulic Press", "line": "Production Line A", "base": [82, 5.8, 1210, 8.4, 88], "last": "2026-10-21", "next": "2026-11-06", "hours": 2140},
    {"id": "MCH-003", "name": "Conveyor Motor", "line": "Production Line B", "base": [61, 2.4, 1760, 5.5, 54], "last": "2026-10-31", "next": "2026-11-10", "hours": 740},
    {"id": "MCH-004", "name": "Industrial Compressor", "line": "Production Line B", "base": [91, 7.1, 990, 9.2, 93], "last": "2026-10-15", "next": "2026-11-05", "hours": 2980},
    {"id": "MCH-005", "name": "Packaging Robot", "line": "Production Line C", "base": [73, 4.0, 1540, 6.7, 67], "last": "2026-10-25", "next": "2026-11-12", "hours": 1080},
    {"id": "MCH-006", "name": "Cooling Pump", "line": "Production Line C", "base": [65, 2.8, 1680, 5.9, 59], "last": "2026-10-30", "next": "2026-11-13", "hours": 620},
]
FEATURE_LIMITS = {
    "Temperature": (0, 200),
    "Vibration": (0, 30),
    "RotationalSpeed": (0, 10000),
    "Pressure": (0, 30),
    "MachineLoad": (0, 150),
}
ROLE_PERMISSIONS = {
    "admin": {"manage_users", "manage_work_orders", "manage_alerts"},
    "operator": {"manage_work_orders", "manage_alerts"},
    "viewer": set(),
}
random_source = np.random.default_rng(24)


def _load_or_create_secret():
    secret_path = INSTANCE_DIR / ".secret_key"
    try:
        return secret_path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        value = secrets.token_hex(32)
        try:
            descriptor = os.open(secret_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as secret_file:
                secret_file.write(value)
        except FileExistsError:
            return secret_path.read_text(encoding="utf-8").strip()
        return value


app.config.update(
    SECRET_KEY=os.environ.get("FORGESIGHT_SECRET_KEY") or _load_or_create_secret(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("FORGESIGHT_SECURE_COOKIE") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
)


@contextmanager
def database():
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def valid_email(value):
    return bool(re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value))


def init_database():
    with database() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
                active INTEGER NOT NULL DEFAULT 1,
                auth_version INTEGER NOT NULL DEFAULT 0,
                failed_logins INTEGER NOT NULL DEFAULT 0,
                locked_until TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS readings (
                id INTEGER PRIMARY KEY,
                machine_id TEXT NOT NULL,
                recorded_at TEXT NOT NULL,
                source TEXT NOT NULL,
                sensors_json TEXT NOT NULL,
                probability REAL,
                health INTEGER,
                risk TEXT,
                FOREIGN KEY (machine_id) REFERENCES machines(id)
            );
            CREATE TABLE IF NOT EXISTS machines (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                line TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS readings_machine_time ON readings(machine_id, recorded_at);
            CREATE TABLE IF NOT EXISTS alerts (
                id INTEGER PRIMARY KEY,
                machine_id TEXT NOT NULL,
                severity TEXT NOT NULL CHECK (severity IN ('Warning', 'Critical')),
                status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
                title TEXT NOT NULL,
                details TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                acknowledged_by INTEGER REFERENCES users(id),
                resolved_by INTEGER REFERENCES users(id),
                FOREIGN KEY (machine_id) REFERENCES machines(id)
            );
            CREATE INDEX IF NOT EXISTS alerts_status_time ON alerts(status, created_at);
            CREATE TABLE IF NOT EXISTS alert_events (
                id INTEGER PRIMARY KEY,
                alert_id INTEGER NOT NULL REFERENCES alerts(id),
                action TEXT NOT NULL,
                details TEXT NOT NULL,
                actor_id INTEGER REFERENCES users(id),
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS alert_events_time ON alert_events(created_at);
            CREATE TABLE IF NOT EXISTS work_orders (
                id TEXT PRIMARY KEY,
                machine_id TEXT NOT NULL REFERENCES machines(id),
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                priority TEXT NOT NULL CHECK (priority IN ('Low', 'Medium', 'High', 'Urgent')),
                status TEXT NOT NULL CHECK (status IN ('Open', 'In progress', 'Completed', 'Cancelled')),
                assigned_to INTEGER REFERENCES users(id),
                due_date TEXT NOT NULL,
                completion_notes TEXT NOT NULL DEFAULT '',
                created_by INTEGER REFERENCES users(id),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS work_orders_due_date ON work_orders(due_date);
            CREATE TABLE IF NOT EXISTS maintenance_schedules (
                machine_id TEXT PRIMARY KEY REFERENCES machines(id),
                last_completed TEXT NOT NULL,
                next_due TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS maintenance_history (
                id INTEGER PRIMARY KEY,
                machine_id TEXT NOT NULL REFERENCES machines(id),
                completed_date TEXT NOT NULL,
                task TEXT NOT NULL,
                completed_by INTEGER REFERENCES users(id),
                recorded_at TEXT NOT NULL,
                UNIQUE (machine_id, completed_date, task)
            );
            CREATE INDEX IF NOT EXISTS maintenance_history_machine_date
                ON maintenance_history(machine_id, completed_date DESC, id DESC);
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY,
                actor_id INTEGER REFERENCES users(id),
                action TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                details TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS audit_log_time ON audit_log(created_at);
        """)
        conn.execute("PRAGMA journal_mode = WAL")
        user_columns = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
        if "auth_version" not in user_columns:
            conn.execute("ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0")
        conn.executemany(
            "INSERT OR IGNORE INTO machines (id, name, line) VALUES (?, ?, ?)",
            [(machine["id"], machine["name"], machine["line"]) for machine in MACHINES],
        )
        conn.executemany(
            """INSERT OR IGNORE INTO maintenance_schedules
               (machine_id, last_completed, next_due, updated_at) VALUES (?, ?, ?, ?)""",
            [(machine["id"], machine["last"], machine["next"], utc_now()) for machine in MACHINES],
        )
        conn.executemany(
            """INSERT OR IGNORE INTO maintenance_history
               (machine_id, completed_date, task, completed_by, recorded_at)
               VALUES (?, ?, ?, NULL, ?)""",
            [
                (machine["id"], day, task, utc_now())
                for machine in MACHINES
                for day, task in (
                    (machine["last"], "Preventive maintenance and visual inspection"),
                    ("2026-10-08", "Lubrication and belt alignment"),
                    ("2026-09-20", "Sensor calibration"),
                )
            ],
        )
        seed_sensor_history(conn)


def seed_sensor_history(conn):
    seeded = conn.execute("SELECT COUNT(*) AS count FROM readings").fetchone()["count"]
    if seeded:
        return
    now = datetime.now(timezone.utc)
    for machine in MACHINES:
        for day in range(13, 0, -1):
            stamp = now - timedelta(days=day)
            values = readings(machine, (13 - day - 6) * 0.1)
            conn.execute(
                "INSERT INTO readings (machine_id, recorded_at, source, sensors_json) VALUES (?, ?, 'demo_history', ?)",
                (machine["id"], stamp.isoformat(timespec="seconds"), json.dumps(values)),
            )
        values = readings(machine)
        conn.execute(
            "INSERT INTO readings (machine_id, recorded_at, source, sensors_json) VALUES (?, ?, 'demo_telemetry', ?)",
            (machine["id"], now.isoformat(timespec="seconds"), json.dumps(values)),
        )


def find_machine(machine_id):
    return next((machine for machine in MACHINES if machine["id"] == machine_id), None)


def load_model():
    if not MODEL_PATH.exists():
        raise RuntimeError("Model not found. Run: python train_model.py")
    return joblib.load(MODEL_PATH)


def readings(machine, offset=0):
    base = np.array(machine["base"], dtype=float)
    noise = random_source.normal(0, [2.2, 0.35, 35, 0.25, 4.5])
    values = base + noise + offset * np.array([0.8, 0.12, -8, 0.08, 1.1])
    return dict(zip(FEATURES, [round(float(value), 1) for value in values]))


def predict(data):
    model = load_model()
    row = np.asarray([[data[key] for key in FEATURES]], dtype=float)
    probability = float(model.predict_proba(row)[0][1])
    risk = "Critical" if probability >= 0.70 else ("Warning" if probability >= 0.35 else "Healthy")
    health = max(5, min(99, round(100 - probability * 75 - max(0, data["Vibration"] - 4) * 2 - max(0, data["Temperature"] - 80) * 0.25)))
    reasons = []
    if data["Temperature"] > 80:
        reasons.append("temperature is above the preferred operating range")
    if data["Vibration"] > 4.5:
        reasons.append("vibration indicates possible imbalance or bearing wear")
    if data["Pressure"] > 8:
        reasons.append("pressure is higher than the normal operating band")
    if data["MachineLoad"] > 85:
        reasons.append("machine load is consistently high")
    if not reasons:
        reasons.append("sensor readings are currently within the expected operating range")
    action = (
        "Stop and inspect the machine; check bearings, lubrication and pressure system."
        if risk == "Critical"
        else "Schedule an inspection within 24–48 hours and verify vibration and temperature."
        if risk == "Warning"
        else "Continue normal operation and follow the planned preventive maintenance schedule."
    )
    return {
        "probability": round(probability * 100, 1),
        "risk": risk,
        "health": health,
        "explanation": "; ".join(reasons) + ".",
        "action": action,
    }


def record_reading(conn, machine_id, sensors, source, result=None, recorded_at=None):
    conn.execute(
        """INSERT INTO readings
           (machine_id, recorded_at, source, sensors_json, probability, health, risk)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            machine_id,
            recorded_at or utc_now(),
            source,
            json.dumps(sensors),
            result["probability"] if result else None,
            result["health"] if result else None,
            result["risk"] if result else None,
        ),
    )


def audit(conn, actor_id, action, entity_type, entity_id, details):
    conn.execute(
        """INSERT INTO audit_log
           (actor_id, action, entity_type, entity_id, details, created_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (actor_id, action, entity_type, str(entity_id), details, utc_now()),
    )


def add_alert_event(conn, alert_id, action, details, actor_id=None):
    conn.execute(
        "INSERT INTO alert_events (alert_id, action, details, actor_id, created_at) VALUES (?, ?, ?, ?, ?)",
        (alert_id, action, details, actor_id, utc_now()),
    )


def sync_alert(conn, machine, prediction):
    latest = conn.execute(
        "SELECT * FROM alerts WHERE machine_id = ? ORDER BY id DESC LIMIT 1",
        (machine["id"],),
    ).fetchone()
    active = latest if latest and latest["status"] != "resolved" else None
    now = utc_now()
    if prediction["risk"] == "Healthy":
        if active:
            conn.execute(
                "UPDATE alerts SET status = 'resolved', updated_at = ? WHERE id = ?",
                (now, active["id"]),
            )
            add_alert_event(conn, active["id"], "resolved", "Machine condition returned to healthy.")
        elif latest and latest["resolved_by"] is not None:
            recovered = conn.execute(
                "SELECT 1 FROM alert_events WHERE alert_id = ? AND action = 'condition_cleared' LIMIT 1",
                (latest["id"],),
            ).fetchone()
            if not recovered:
                add_alert_event(conn, latest["id"], "condition_cleared", "Machine condition returned to healthy.")
        return
    if active and active["severity"] == prediction["risk"]:
        conn.execute(
            "UPDATE alerts SET details = ?, updated_at = ? WHERE id = ?",
            (prediction["action"], now, active["id"]),
        )
        return
    if active:
        conn.execute("UPDATE alerts SET status = 'resolved', updated_at = ? WHERE id = ?", (now, active["id"]))
        add_alert_event(conn, active["id"], "updated", f"Previous {active['severity']} alert closed after risk changed.")
    elif latest and latest["severity"] == prediction["risk"] and latest["resolved_by"] is not None:
        recovered = conn.execute(
            "SELECT 1 FROM alert_events WHERE alert_id = ? AND action = 'condition_cleared' LIMIT 1",
            (latest["id"],),
        ).fetchone()
        if not recovered:
            return
    cursor = conn.execute(
        """INSERT INTO alerts
           (machine_id, severity, status, title, details, created_at, updated_at)
           VALUES (?, ?, 'open', ?, ?, ?, ?)""",
        (
            machine["id"],
            prediction["risk"],
            f"{prediction['risk']} machine condition",
            prediction["action"],
            now,
            now,
        ),
    )
    add_alert_event(conn, cursor.lastrowid, "raised", f"{prediction['risk']} alert created.")


def latest_reading(conn, machine_id, telemetry_only=True):
    source_filter = "AND source IN ('demo_telemetry', 'demo_history')" if telemetry_only else ""
    return conn.execute(
        f"SELECT * FROM readings WHERE machine_id = ? {source_filter} ORDER BY recorded_at DESC, id DESC LIMIT 1",
        (machine_id,),
    ).fetchone()


def machine_payload(conn, machine):
    latest = latest_reading(conn, machine["id"])
    data = json.loads(latest["sensors_json"])
    prediction = predict(data)
    if latest["risk"] != prediction["risk"] or latest["probability"] is None:
        conn.execute(
            "UPDATE readings SET probability = ?, health = ?, risk = ? WHERE id = ?",
            (prediction["probability"], prediction["health"], prediction["risk"], latest["id"]),
        )
    sync_alert(conn, machine, prediction)
    return {
        **machine,
        "sensors": data,
        **prediction,
        "status": prediction["risk"],
        "runtime": f'{machine["hours"]:,} hrs',
        "last_sampled": latest["recorded_at"],
    }


def maintenance_payload(conn, machine):
    schedule = conn.execute(
        """SELECT ms.machine_id, ms.last_completed, ms.next_due, m.name, m.line
           FROM maintenance_schedules ms JOIN machines m ON m.id = ms.machine_id
           WHERE ms.machine_id = ?""",
        (machine["id"],),
    ).fetchone()
    today = datetime.now(timezone.utc).date().isoformat()
    due = schedule["next_due"] <= today
    return {
        "machine_id": schedule["machine_id"],
        "machine_name": schedule["name"],
        "line": schedule["line"],
        "last_completed": schedule["last_completed"],
        "next_due": schedule["next_due"],
        "is_due": due,
        "due_status": (
            "Due today" if schedule["next_due"] == today
            else "Overdue" if due
            else "Scheduled"
        ),
    }


def analyze_root_cause(sensors, history, risk):
    causes = []
    thresholds = {
        "Temperature": (80, "Elevated temperature", "Check cooling airflow, lubrication, and thermal load."),
        "Vibration": (4.5, "Elevated vibration", "Inspect bearings, alignment, and rotating components."),
        "Pressure": (8, "Elevated pressure", "Inspect the pressure regulator, filter, and downstream restriction."),
        "MachineLoad": (85, "High machine load", "Review the production load and check for mechanical drag."),
    }
    for key, (threshold, label, action) in thresholds.items():
        value = sensors[key]
        if value > threshold:
            previous = [entry[key] for entry in history[1:5] if key in entry]
            rising = bool(previous and value > sum(previous) / len(previous))
            causes.append({
                "sensor": key,
                "title": label,
                "observation": f"{value:g} exceeds the {threshold:g} operating threshold"
                              + (" and is above recent readings." if rising else "."),
                "recommendation": action,
                "score": round(min(100, 55 + (value - threshold) / max(threshold, 1) * 100 + (10 if rising else 0))),
            })
    causes.sort(key=lambda cause: cause["score"], reverse=True)
    if not causes:
        causes.append({
            "sensor": None,
            "title": "No threshold breach identified",
            "observation": (
                "The model estimates elevated risk, but the available sensor snapshot does not isolate a threshold breach."
                if risk != "Healthy"
                else "Current readings are within the configured diagnostic thresholds."
            ),
            "recommendation": "Validate sensor calibration and review the physical inspection history.",
            "score": 0,
        })
    return {
        "causes": causes,
        "basis": "Sensor thresholds and recent reading comparison; not a confirmed physical diagnosis.",
    }


def detect_sensor_issues(rows):
    issues = []
    limits = {
        "Temperature": 15,
        "Vibration": 2.5,
        "RotationalSpeed": 250,
        "Pressure": 1.5,
        "MachineLoad": 20,
    }
    operating_thresholds = {
        "Temperature": 80,
        "Vibration": 4.5,
        "Pressure": 8,
        "MachineLoad": 85,
    }
    if not rows:
        return [{"sensor": None, "status": "warning", "issue": "No sensor readings are available."}]
    parsed_rows = []
    for row in rows:
        try:
            sample = json.loads(row["sensors_json"])
        except (KeyError, TypeError, json.JSONDecodeError):
            return [{"sensor": None, "status": "warning", "issue": "A saved sensor sample could not be read; check the telemetry record."}]
        if not isinstance(sample, dict):
            return [{"sensor": None, "status": "warning", "issue": "A saved sensor sample has an invalid format; check the telemetry record."}]
        parsed_rows.append(sample)
    for key in FEATURES:
        try:
            values = [float(sample[key]) for sample in parsed_rows if key in sample]
        except (TypeError, ValueError):
            issues.append({"sensor": key, "status": "warning", "issue": "A saved sensor value is not numeric; check the telemetry record."})
            continue
        if not values:
            issues.append({"sensor": key, "status": "warning", "issue": "No samples are available for this sensor."})
            continue
        if not all(math.isfinite(value) for value in values):
            issues.append({"sensor": key, "status": "warning", "issue": "A saved sensor value is not finite; check the telemetry record."})
            continue
        issue = None
        if len(values) >= 4 and len(set(values[:4])) == 1:
            issue = "Four consecutive identical samples; possible stuck signal."
        elif len(values) >= 2 and abs(values[0] - values[1]) > limits[key]:
            issue = f"Latest change of {abs(values[0] - values[1]):g} exceeds the configured step-change threshold."
        elif key in operating_thresholds and values[0] > operating_thresholds[key]:
            issue = f"Latest reading of {values[0]:g} exceeds the configured operating threshold of {operating_thresholds[key]:g}; verify the sensor and machine condition."
        if issue:
            issues.append({"sensor": key, "status": "warning", "issue": issue})
    try:
        sampled_at = datetime.fromisoformat(rows[0]["recorded_at"])
        if datetime.now(timezone.utc) - sampled_at.astimezone(timezone.utc) > timedelta(minutes=15):
            issues.append({
                "sensor": None,
                "status": "warning",
                "issue": "Telemetry is older than 15 minutes; this may indicate an inactive demo session rather than sensor failure.",
            })
    except (KeyError, TypeError, ValueError):
        issues.append({"sensor": None, "status": "warning", "issue": "Latest sample timestamp could not be interpreted."})
    return issues


def production_impact(machine, fleet):
    line_fleet = [item for item in fleet if item["line"] == machine["line"]]
    at_risk = [item for item in line_fleet if item["risk"] != "Healthy"]
    downtime = {"Critical": "4–8", "Warning": "1–3", "Healthy": "0"}[machine["risk"]]
    return {
        "line": machine["line"],
        "line_assets": len(line_fleet),
        "line_assets_at_risk": len(at_risk),
        "estimated_downtime_hours": downtime,
        "basis": "Planning scenario derived from current model severity. Throughput, redundancy, and cost data are not configured.",
    }


def capture_demo_telemetry(conn):
    now = datetime.now(timezone.utc)
    for machine in MACHINES:
        latest = latest_reading(conn, machine["id"])
        last_at = datetime.fromisoformat(latest["recorded_at"])
        if now - last_at < timedelta(minutes=5):
            continue
        values = readings(machine)
        result = predict(values)
        record_reading(conn, machine["id"], values, "demo_telemetry", result, now.isoformat(timespec="seconds"))
        sync_alert(conn, machine, result)


def public_user(user):
    return {
        "id": user["id"],
        "name": user["name"],
        "email": user["email"],
        "role": user["role"],
        "active": bool(user["active"]),
        "created_at": user["created_at"],
    }


def api_error(message, status):
    return jsonify({"error": message}), status


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        user_id = session.get("user_id")
        if not user_id:
            if request.path.startswith("/api/"):
                return api_error("Please sign in to continue.", 401)
            return redirect(url_for("login", next=request.full_path))
        with database() as conn:
            user = conn.execute("SELECT * FROM users WHERE id = ? AND active = 1", (user_id,)).fetchone()
        if not user or session.get("auth_version") != user["auth_version"]:
            session.clear()
            return api_error("Your account is unavailable. Please sign in again.", 401) if request.path.startswith("/api/") else redirect(url_for("login"))
        g.user = user
        return view(*args, **kwargs)
    return wrapped


def permission_required(permission):
    def decorator(view):
        @wraps(view)
        @login_required
        def wrapped(*args, **kwargs):
            if permission not in ROLE_PERMISSIONS[g.user["role"]]:
                return api_error("Your account does not have permission to perform this action.", 403)
            return view(*args, **kwargs)
        return wrapped
    return decorator


@app.after_request
def set_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    return response


@app.before_request
def protect_state_changes():
    if request.method not in {"POST", "PUT", "PATCH", "DELETE"}:
        return None
    if request.endpoint not in {"login", "setup"} and not session.get("user_id"):
        return None
    expected = session.get("csrf_token")
    provided = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
    if not expected or not provided or not secrets.compare_digest(expected, provided):
        if request.path.startswith("/api/"):
            return api_error("Your security token expired. Refresh the page and try again.", 400)
        return "Your security token expired. Please reload and try again.", 400
    return None


@app.context_processor
def template_context():
    if getattr(g, "user", None):
        return {
            "current_user": public_user(g.user),
            "csrf_token": session.get("csrf_token"),
        }
    return {"current_user": None, "csrf_token": session.get("csrf_token")}


@app.route("/setup", methods=["GET", "POST"])
def setup():
    with database() as conn:
        if request.method == "POST":
            conn.execute("BEGIN IMMEDIATE")
        user_count = conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()["count"]
        if user_count:
            return redirect(url_for("home"))
        if request.method == "POST":
            name = request.form.get("name", "").strip()
            email = request.form.get("email", "").strip().lower()
            password = request.form.get("password", "")
            if len(name) < 2 or len(name) > 80 or not valid_email(email) or len(email) > 254:
                return render_template("auth.html", mode="setup", error="Enter a valid name and email address."), 400
            if len(password) < 12:
                return render_template("auth.html", mode="setup", error="Use a password with at least 12 characters."), 400
            cursor = conn.execute(
                "INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
                (name, email, generate_password_hash(password), utc_now()),
            )
            audit(conn, cursor.lastrowid, "created", "user", cursor.lastrowid, "Initial administrator account created.")
            session.clear()
            session["user_id"] = cursor.lastrowid
            session["auth_version"] = 0
            session["csrf_token"] = secrets.token_urlsafe(32)
            session.permanent = True
            return redirect(url_for("home"))
    session.setdefault("csrf_token", secrets.token_urlsafe(32))
    return render_template("auth.html", mode="setup", error=None)


@app.route("/login", methods=["GET", "POST"])
def login():
    with database() as conn:
        user_count = conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()["count"]
    if not user_count:
        return redirect(url_for("setup"))
    if session.get("user_id"):
        return redirect(url_for("home"))
    error = None
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        with database() as conn:
            user = conn.execute("SELECT * FROM users WHERE email = ? COLLATE NOCASE", (email,)).fetchone()
            locked = user and user["locked_until"] and datetime.fromisoformat(user["locked_until"]) > datetime.now(timezone.utc)
            if user and user["active"] and not locked and check_password_hash(user["password_hash"], password):
                conn.execute("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?", (user["id"],))
                audit(conn, user["id"], "signed_in", "user", user["id"], "Successful sign-in.")
                session.clear()
                session["user_id"] = user["id"]
                session["auth_version"] = user["auth_version"]
                session["csrf_token"] = secrets.token_urlsafe(32)
                session.permanent = True
                return redirect(url_for("home"))
            if user:
                failed = user["failed_logins"] + 1
                locked_until = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(timespec="seconds") if failed >= 5 else None
                conn.execute(
                    "UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?",
                    (failed, locked_until, user["id"]),
                )
            error = "Sign-in failed. Check your credentials or contact an administrator."
    session.setdefault("csrf_token", secrets.token_urlsafe(32))
    return render_template("auth.html", mode="login", error=error)


@app.post("/logout")
@login_required
def logout():
    with database() as conn:
        audit(conn, g.user["id"], "signed_out", "user", g.user["id"], "Signed out.")
    session.clear()
    return redirect(url_for("login"))


@app.route("/")
@login_required
def home():
    return render_template("index.html")


@app.get("/api/session")
@login_required
def session_info():
    return jsonify({"user": public_user(g.user), "csrf_token": session["csrf_token"], "permissions": sorted(ROLE_PERMISSIONS[g.user["role"]])})


@app.get("/api/machines")
@login_required
def machines():
    result = []
    with database() as conn:
        capture_demo_telemetry(conn)
        for machine in MACHINES:
            result.append(machine_payload(conn, machine))
    return jsonify({
        "machines": result,
        "summary": {
            "total": len(result),
            "healthy": sum(item["risk"] == "Healthy" for item in result),
            "warning": sum(item["risk"] == "Warning" for item in result),
            "critical": sum(item["risk"] == "Critical" for item in result),
            "maintenance": sum(item["risk"] != "Healthy" for item in result),
        },
    })


@app.get("/api/intelligence")
@login_required
def intelligence():
    with database() as conn:
        capture_demo_telemetry(conn)
        fleet = [machine_payload(conn, machine) for machine in MACHINES]
        for machine in fleet:
            rows = conn.execute(
                """SELECT recorded_at, sensors_json FROM readings
                   WHERE machine_id = ? ORDER BY id DESC LIMIT 8""",
                (machine["id"],),
            ).fetchall()
            recent = [json.loads(row["sensors_json"]) for row in rows]
            machine["root_cause"] = analyze_root_cause(machine["sensors"], recent, machine["risk"])
            machine["sensor_issues"] = detect_sensor_issues(rows)
            machine["sensor_sample_count"] = len(rows)
        for machine in fleet:
            machine["production_impact"] = production_impact(machine, fleet)
    return jsonify({"machines": fleet})


@app.post("/api/assistant")
@login_required
def gemini_assistant():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return api_error("Submit the question as a JSON object.", 400)
    question = body.get("question")
    if not isinstance(question, str) or not question.strip() or len(question) > 2000:
        return api_error("Enter a question of 1–2,000 characters.", 400)
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return api_error("Gemini is not configured. Set GEMINI_API_KEY on the server and restart ForgeSight.", 503)
    model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash").strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]+", model):
        return api_error("The configured Gemini model name is invalid.", 500)
    with database() as conn:
        fleet = [machine_payload(conn, machine) for machine in MACHINES]
    context = [{
        "id": machine["id"],
        "name": machine["name"],
        "line": machine["line"],
        "risk": machine["risk"],
        "failure_probability": machine["probability"],
        "health": machine["health"],
        "sensors": machine["sensors"],
    } for machine in fleet]
    payload = {
        "systemInstruction": {
            "parts": [{
                "text": (
                    "You are ForgeSight's maintenance decision-support assistant. Answer from the supplied "
                    "current fleet snapshot. Be concise, explain uncertainty, and never claim sensor estimates "
                    "are confirmed failures. Do not recommend bypassing safety procedures; advise qualified "
                    "personnel to verify conditions and follow site procedures."
                )
            }]
        },
        "contents": [{
            "role": "user",
            "parts": [{
                "text": f"Current fleet snapshot: {json.dumps(context)}\n\nQuestion: {question.strip()}"
            }]
        }],
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 600},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    req = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST",
    )
    try:
        with urlopen(req, timeout=20) as response:
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        error.close()
        app.logger.warning("Gemini API returned HTTP %s.", error.code)
        return api_error("Gemini could not answer right now. Check the server API key, model access, and quota.", 502)
    except (URLError, TimeoutError) as error:
        app.logger.warning("Could not reach Gemini API: %s", error)
        return api_error("Could not reach Gemini. Check the server network connection and try again.", 502)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        app.logger.warning("Gemini returned an unreadable response: %s", error)
        return api_error("Gemini returned an unreadable response. Please try again.", 502)
    parts = [
        part.get("text", "")
        for candidate in result.get("candidates", [])
        for part in candidate.get("content", {}).get("parts", [])
        if isinstance(part.get("text"), str)
    ]
    answer = "\n".join(part for part in parts if part).strip()
    if not answer:
        return api_error("Gemini did not return an answer. Please rephrase your question and try again.", 502)
    return jsonify({"answer": answer})


@app.get("/api/machine/<machine_id>")
@login_required
def machine_detail(machine_id):
    machine = find_machine(machine_id)
    if not machine:
        return api_error("Machine not found.", 404)
    with database() as conn:
        payload = machine_payload(conn, machine)
        maintenance = maintenance_payload(conn, machine)
        history = conn.execute(
            """SELECT recorded_at, sensors_json, probability, health, risk, source
               FROM readings WHERE machine_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 30""",
            (machine_id,),
        ).fetchall()
        maintenance_history = conn.execute(
            """SELECT h.completed_date, h.task, u.name AS technician
               FROM maintenance_history h
               LEFT JOIN users u ON u.id = h.completed_by
               WHERE h.machine_id = ?
               ORDER BY h.completed_date DESC, h.id DESC LIMIT 100""",
            (machine_id,),
        ).fetchall()
    payload["history"] = [
        {
            "label": datetime.fromisoformat(row["recorded_at"]).astimezone().strftime("%d %b %H:%M"),
            "temperature": json.loads(row["sensors_json"])["Temperature"],
            "vibration": json.loads(row["sensors_json"])["Vibration"],
            "load": json.loads(row["sensors_json"])["MachineLoad"],
            "recorded_at": row["recorded_at"],
            "source": row["source"],
        }
        for row in reversed(history)
    ]
    payload["last"] = maintenance["last_completed"]
    payload["next"] = maintenance["next_due"]
    payload["maintenance"] = maintenance
    payload["maintenance_log"] = [
        {
            "date": row["completed_date"],
            "task": row["task"],
            "technician": row["technician"] or "Maintenance Team",
            "result": "Completed",
        }
        for row in maintenance_history
    ]
    payload["weekly_plan"] = [
        {"day": "Monday", "task": "Visual inspection and cleaning"},
        {"day": "Wednesday", "task": "Check vibration, temperature and lubrication"},
        {"day": "Friday", "task": "Review operating hours and tighten critical fasteners"},
    ]
    return jsonify(payload)


@app.get("/api/maintenance")
@login_required
def get_maintenance_schedule():
    with database() as conn:
        schedules = [
            maintenance_payload(conn, machine)
            for machine in MACHINES
        ]
    due = [schedule for schedule in schedules if schedule["is_due"]]
    return jsonify({
        "schedules": schedules,
        "due_count": len(due),
        "can_manage": "manage_work_orders" in ROLE_PERMISSIONS[g.user["role"]],
    })


@app.post("/api/machine/<machine_id>/maintenance/complete")
@permission_required("manage_work_orders")
def complete_maintenance(machine_id):
    machine = find_machine(machine_id)
    if not machine:
        return api_error("Machine not found.", 404)
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return api_error("Submit maintenance details as a JSON object.", 400)
    task = body.get("task", "Preventive maintenance and visual inspection")
    if not isinstance(task, str) or not 3 <= len(task.strip()) <= 2000:
        return api_error("Enter a maintenance task between 3 and 2,000 characters.", 400)
    task = task.strip()
    today = datetime.now(timezone.utc).date()
    completed_date = today.isoformat()
    next_due = (today + timedelta(days=7)).isoformat()
    with database() as conn:
        schedule = conn.execute(
            "SELECT next_due FROM maintenance_schedules WHERE machine_id = ?",
            (machine_id,),
        ).fetchone()
        if not schedule:
            return api_error("Maintenance schedule not found.", 404)
        if schedule["next_due"] > completed_date:
            return api_error("This machine's maintenance is not due yet.", 409)
        conn.execute(
            """INSERT INTO maintenance_history
               (machine_id, completed_date, task, completed_by, recorded_at)
               VALUES (?, ?, ?, ?, ?)""",
            (machine_id, completed_date, task, g.user["id"], utc_now()),
        )
        conn.execute(
            """UPDATE maintenance_schedules
               SET last_completed = ?, next_due = ?, updated_at = ?
               WHERE machine_id = ?""",
            (completed_date, next_due, utc_now(), machine_id),
        )
        audit(
            conn, g.user["id"], "maintenance_completed", "machine", machine_id,
            f"Completed maintenance: {task}. Next due {next_due}.",
        )
        updated_schedule = maintenance_payload(conn, machine)
    return jsonify({"schedule": updated_schedule, "task": task})


@app.get("/api/machine/<machine_id>/history")
@login_required
def machine_history(machine_id):
    if not find_machine(machine_id):
        return api_error("Machine not found.", 404)
    try:
        limit = max(1, min(int(request.args.get("limit", 30)), 500))
    except ValueError:
        return api_error("Limit must be an integer.", 400)
    with database() as conn:
        rows = conn.execute(
            """SELECT recorded_at, sensors_json, probability, health, risk, source
               FROM readings WHERE machine_id = ? ORDER BY recorded_at DESC, id DESC LIMIT ?""",
            (machine_id, limit),
        ).fetchall()
    return jsonify({"machine_id": machine_id, "history": [
        {
            "recorded_at": row["recorded_at"],
            "sensors": json.loads(row["sensors_json"]),
            "probability": row["probability"],
            "health": row["health"],
            "risk": row["risk"],
            "source": row["source"],
        }
        for row in reversed(rows)
    ]})


@app.post("/api/predict")
@permission_required("manage_work_orders")
def run_prediction():
    body = request.get_json(silent=True) or {}
    machine_id = str(body.get("machine_id", ""))
    machine = find_machine(machine_id)
    if not machine:
        return api_error("Select a valid machine.", 400)
    try:
        data = body.get("sensors") or {}
        clean = {}
        for key in FEATURES:
            value = float(data[key])
            if not math.isfinite(value):
                raise ValueError()
            low, high = FEATURE_LIMITS[key]
            if not low <= value <= high:
                return api_error(f"{key} must be between {low} and {high}.", 400)
            clean[key] = value
        result = predict(clean)
    except (KeyError, TypeError, ValueError):
        return api_error("Enter valid numeric values for all five sensor readings.", 400)
    except RuntimeError as error:
        return api_error(str(error), 500)
    with database() as conn:
        record_reading(conn, machine_id, clean, "manual_prediction", result)
        audit(conn, g.user["id"], "prediction_run", "machine", machine_id, f"Manual prediction: {result['risk']} risk, {result['probability']}%.")
    return jsonify({"machine_id": machine_id, "sensors": clean, **result, "timestamp": utc_now()})


def alert_payload(row):
    return {
        "id": row["id"],
        "machine_id": row["machine_id"],
        "machine_name": row["machine_name"],
        "line": row["line"],
        "severity": row["severity"],
        "status": row["status"],
        "title": row["title"],
        "details": row["details"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "acknowledged_by_name": row["acknowledged_by_name"],
        "resolved_by_name": row["resolved_by_name"],
    }


@app.get("/api/alerts")
@login_required
def get_alerts():
    with database() as conn:
        alerts = conn.execute(
            """SELECT a.*, m.name AS machine_name, m.line,
                      ack.name AS acknowledged_by_name, res.name AS resolved_by_name
               FROM alerts a JOIN machines m ON m.id = a.machine_id
               LEFT JOIN users ack ON ack.id = a.acknowledged_by
               LEFT JOIN users res ON res.id = a.resolved_by
               ORDER BY CASE a.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
                        a.created_at DESC"""
        ).fetchall()
        events = conn.execute(
            """SELECT e.id, e.alert_id, e.action, e.details, e.created_at, u.name AS actor_name,
                      a.machine_id, m.name AS machine_name, a.severity
               FROM alert_events e JOIN alerts a ON a.id = e.alert_id
               JOIN machines m ON m.id = a.machine_id
               LEFT JOIN users u ON u.id = e.actor_id
               ORDER BY e.id DESC LIMIT 200"""
        ).fetchall()
    return jsonify({
        "alerts": [alert_payload(alert) for alert in alerts],
        "events": [dict(row) for row in events],
        "can_manage": "manage_alerts" in ROLE_PERMISSIONS[g.user["role"]],
    })


@app.post("/api/alerts/<int:alert_id>/action")
@permission_required("manage_alerts")
def update_alert(alert_id):
    body = request.get_json(silent=True) or {}
    action = body.get("action")
    if action not in {"acknowledge", "resolve"}:
        return api_error("Choose acknowledge or resolve.", 400)
    with database() as conn:
        alert = conn.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()
        if not alert:
            return api_error("Alert not found.", 404)
        if alert["status"] == "resolved":
            return api_error("This alert has already been resolved.", 409)
        now = utc_now()
        if action == "acknowledge":
            conn.execute(
                "UPDATE alerts SET status = 'acknowledged', acknowledged_by = ?, updated_at = ? WHERE id = ?",
                (g.user["id"], now, alert_id),
            )
            event_action, details = "acknowledged", f"Acknowledged by {g.user['name']}."
        else:
            conn.execute(
                "UPDATE alerts SET status = 'resolved', resolved_by = ?, updated_at = ? WHERE id = ?",
                (g.user["id"], now, alert_id),
            )
            event_action, details = "resolved", f"Resolved by {g.user['name']}."
        add_alert_event(conn, alert_id, event_action, details, g.user["id"])
        audit(conn, g.user["id"], event_action, "alert", alert_id, details)
    return jsonify({"id": alert_id, "status": "acknowledged" if action == "acknowledge" else "resolved"})


@app.get("/api/work-orders")
@login_required
def get_work_orders():
    with database() as conn:
        orders = conn.execute(
            """SELECT w.*, m.name AS machine_name, m.line, assignee.name AS assignee_name,
                      creator.name AS creator_name
               FROM work_orders w JOIN machines m ON m.id = w.machine_id
               LEFT JOIN users assignee ON assignee.id = w.assigned_to
               LEFT JOIN users creator ON creator.id = w.created_by
               ORDER BY CASE w.status WHEN 'Open' THEN 0 WHEN 'In progress' THEN 1 ELSE 2 END,
                        w.due_date, w.created_at DESC"""
        ).fetchall()
        users = conn.execute("SELECT id, name, role FROM users WHERE active = 1 ORDER BY name").fetchall()
    return jsonify({
        "work_orders": [dict(row) for row in orders],
        "assignees": [dict(user) for user in users if user["role"] == "operator"],
        "can_manage": "manage_work_orders" in ROLE_PERMISSIONS[g.user["role"]],
    })


@app.get("/api/my-work-orders")
@login_required
def get_my_work_orders():
    if g.user["role"] != "operator":
        return jsonify({"user_name": g.user["name"], "work_orders": []})
    with database() as conn:
        orders = conn.execute(
            """SELECT w.id, w.machine_id, m.name AS machine_name, m.line,
                      w.title, w.description, w.priority, w.status, w.due_date,
                      creator.name AS assigned_by, creator.role AS assigned_by_role
               FROM work_orders w
               JOIN machines m ON m.id = w.machine_id
               LEFT JOIN users creator ON creator.id = w.created_by
               WHERE w.assigned_to = ? AND w.status IN ('Open', 'In progress')
               ORDER BY CASE w.status WHEN 'In progress' THEN 0 ELSE 1 END,
                        w.due_date, w.created_at DESC""",
            (g.user["id"],),
        ).fetchall()
    return jsonify({
        "user_name": g.user["name"],
        "work_orders": [dict(order) for order in orders],
    })


@app.post("/api/work-orders")
@permission_required("manage_work_orders")
def create_work_order():
    body = request.get_json(silent=True) or {}
    machine_id = str(body.get("machine_id", ""))
    title = str(body.get("title", "")).strip()
    description = str(body.get("description", "")).strip()
    due_date = str(body.get("due_date", ""))
    priority = body.get("priority", "Medium")
    assigned_to = body.get("assigned_to")
    if not find_machine(machine_id):
        return api_error("Choose a valid machine.", 400)
    if not 3 <= len(title) <= 120 or len(description) > 2000:
        return api_error("Enter a work-order title (3–120 characters) and a description under 2,000 characters.", 400)
    try:
        datetime.strptime(due_date, "%Y-%m-%d")
    except ValueError:
        return api_error("Enter a valid due date.", 400)
    if priority not in {"Low", "Medium", "High", "Urgent"}:
        return api_error("Choose a valid priority.", 400)
    try:
        assigned_to = int(assigned_to) if assigned_to not in (None, "") else None
    except (ValueError, TypeError):
        return api_error("Choose a valid assignee.", 400)
    with database() as conn:
        if assigned_to is not None:
            assignee = conn.execute("SELECT id FROM users WHERE id = ? AND active = 1 AND role = 'operator'", (assigned_to,)).fetchone()
            if not assignee:
                return api_error("Choose an active machine operator as assignee.", 400)
        now = utc_now()
        order_id = f"WO-{secrets.token_hex(4).upper()}"
        conn.execute(
            """INSERT INTO work_orders
               (id, machine_id, title, description, priority, status, assigned_to, due_date, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?, ?)""",
            (order_id, machine_id, title, description, priority, assigned_to, due_date, g.user["id"], now, now),
        )
        audit(conn, g.user["id"], "created", "work_order", order_id, f"Created {priority.lower()} priority work order for {machine_id}.")
    return jsonify({"id": order_id}), 201


@app.post("/api/work-orders/automate")
@permission_required("manage_work_orders")
def automate_work_orders():
    with database() as conn:
        alerts = conn.execute(
            """SELECT a.machine_id, a.severity, a.details, m.name AS machine_name
               FROM alerts a JOIN machines m ON m.id = a.machine_id
               WHERE a.status IN ('open', 'acknowledged')
               ORDER BY CASE a.severity WHEN 'Critical' THEN 0 ELSE 1 END, a.created_at"""
        ).fetchall()
        created = []
        skipped = 0
        now = utc_now()
        for alert in alerts:
            title = f"Automated inspection: {alert['severity']} condition"
            existing = conn.execute(
                """SELECT id FROM work_orders
                   WHERE machine_id = ? AND title = ? AND status IN ('Open', 'In progress')
                   LIMIT 1""",
                (alert["machine_id"], title),
            ).fetchone()
            if existing:
                skipped += 1
                continue
            due_days = 0 if alert["severity"] == "Critical" else 1
            due_date = (datetime.now(timezone.utc).date() + timedelta(days=due_days)).isoformat()
            priority = "Urgent" if alert["severity"] == "Critical" else "High"
            description = (
                f"Automatically generated from the active {alert['severity'].lower()} alert for "
                f"{alert['machine_name']}. Alert context: {alert['details']} "
                "Inspect the asset, validate sensor readings, and follow site safety procedures."
            )
            order_id = f"WO-{secrets.token_hex(4).upper()}"
            conn.execute(
                """INSERT INTO work_orders
                   (id, machine_id, title, description, priority, status, due_date, created_by, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?)""",
                (order_id, alert["machine_id"], title, description, priority, due_date, g.user["id"], now, now),
            )
            audit(
                conn, g.user["id"], "automated", "work_order", order_id,
                f"Generated from active {alert['severity'].lower()} alert for {alert['machine_id']}.",
            )
            created.append({"id": order_id, "machine_id": alert["machine_id"], "priority": priority})
    return jsonify({"created": created, "created_count": len(created), "skipped_count": skipped})


@app.patch("/api/work-orders/<order_id>")
@permission_required("manage_work_orders")
def update_work_order(order_id):
    body = request.get_json(silent=True) or {}
    allowed = {"status", "assigned_to", "completion_notes", "due_date"}
    if set(body) - allowed or not body:
        return api_error("Provide a valid work-order update.", 400)
    with database() as conn:
        order = conn.execute("SELECT * FROM work_orders WHERE id = ?", (order_id,)).fetchone()
        if not order:
            return api_error("Work order not found.", 404)
        updates = {}
        if "status" in body:
            if body["status"] not in {"Open", "In progress", "Completed", "Cancelled"}:
                return api_error("Choose a valid work-order status.", 400)
            updates["status"] = body["status"]
        if "assigned_to" in body:
            try:
                assignee_id = int(body["assigned_to"]) if body["assigned_to"] else None
            except (TypeError, ValueError):
                return api_error("Choose a valid assignee.", 400)
            if assignee_id is not None and not conn.execute(
                "SELECT id FROM users WHERE id = ? AND active = 1 AND role = 'operator'",
                (assignee_id,),
            ).fetchone():
                return api_error("Choose an active machine operator as assignee.", 400)
            updates["assigned_to"] = assignee_id
        if "completion_notes" in body:
            notes = str(body["completion_notes"]).strip()
            if len(notes) > 2000:
                return api_error("Completion notes must be under 2,000 characters.", 400)
            updates["completion_notes"] = notes
        if "due_date" in body:
            try:
                datetime.strptime(body["due_date"], "%Y-%m-%d")
            except (TypeError, ValueError):
                return api_error("Enter a valid due date.", 400)
            updates["due_date"] = body["due_date"]
        assignments = ", ".join(f"{key} = ?" for key in updates)
        conn.execute(
            f"UPDATE work_orders SET {assignments}, updated_at = ? WHERE id = ?",
            (*updates.values(), utc_now(), order_id),
        )
        details = "; ".join(f"{key.replace('_', ' ')}: {value}" for key, value in updates.items())
        audit(conn, g.user["id"], "updated", "work_order", order_id, details)
    return jsonify({"id": order_id, "updated": updates})


@app.get("/api/users")
@permission_required("manage_users")
def get_users():
    with database() as conn:
        users = conn.execute("SELECT * FROM users ORDER BY active DESC, name").fetchall()
    return jsonify({"users": [public_user(user) for user in users], "current_user_id": g.user["id"]})


@app.post("/api/users")
@permission_required("manage_users")
def create_user():
    body = request.get_json(silent=True) or {}
    name = str(body.get("name", "")).strip()
    email = str(body.get("email", "")).strip().lower()
    password = body.get("password", "")
    role = body.get("role")
    if not 2 <= len(name) <= 80 or not valid_email(email) or len(email) > 254:
        return api_error("Enter a valid name and email address.", 400)
    if not isinstance(password, str) or len(password) < 12:
        return api_error("Use an initial password with at least 12 characters.", 400)
    if role not in {"admin", "operator", "viewer"}:
        return api_error("Choose admin, operator, or viewer role.", 400)
    with database() as conn:
        try:
            cursor = conn.execute(
                "INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
                (name, email, generate_password_hash(password), role, utc_now()),
            )
        except sqlite3.IntegrityError:
            return api_error("An account with that email already exists.", 409)
        audit(conn, g.user["id"], "created", "user", cursor.lastrowid, f"Created {role} account for {email}.")
    return jsonify({"id": cursor.lastrowid}), 201


@app.patch("/api/users/<int:user_id>")
@permission_required("manage_users")
def update_user(user_id):
    body = request.get_json(silent=True) or {}
    if set(body) - {"role", "active", "password"} or not body:
        return api_error("Provide a valid user update.", 400)
    if user_id == g.user["id"] and (body.get("active") is False or body.get("role", "admin") != "admin"):
        return api_error("You cannot deactivate or demote your own administrator account.", 400)
    updates = {}
    if "role" in body:
        if body["role"] not in ROLE_PERMISSIONS:
            return api_error("Choose admin, operator, or viewer role.", 400)
        updates["role"] = body["role"]
    if "active" in body:
        if not isinstance(body["active"], bool):
            return api_error("Active must be true or false.", 400)
        updates["active"] = int(body["active"])
    if "password" in body:
        password = body["password"]
        if not isinstance(password, str) or len(password) < 12:
            return api_error("Use a password with at least 12 characters.", 400)
        updates["password_hash"] = generate_password_hash(password)
    with database() as conn:
        target = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not target:
            return api_error("User not found.", 404)
        if target["role"] == "admin" and (updates.get("role") not in (None, "admin") or updates.get("active") == 0):
            active_admins = conn.execute("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").fetchone()["count"]
            if target["active"] and active_admins <= 1:
                return api_error("The last active administrator cannot be demoted or disabled.", 400)
        assignments = ", ".join(f"{key} = ?" for key in updates)
        conn.execute(f"UPDATE users SET {assignments} WHERE id = ?", (*updates.values(), user_id))
        if "password_hash" in updates or "active" in updates:
            conn.execute(
                "UPDATE users SET failed_logins = 0, locked_until = NULL, auth_version = auth_version + ? WHERE id = ?",
                (int("password_hash" in updates), user_id),
            )
        audit(conn, g.user["id"], "updated", "user", user_id, ", ".join(f"{key} changed" for key in updates))
        if updates.get("active") == 0:
            conn.execute("UPDATE work_orders SET assigned_to = NULL, updated_at = ? WHERE assigned_to = ?", (utc_now(), user_id))
    return jsonify({"id": user_id, "updated": list(updates)})


@app.post("/api/me/password")
@login_required
def change_password():
    body = request.get_json(silent=True) or {}
    current_password = body.get("current_password", "")
    new_password = body.get("new_password", "")
    if not isinstance(new_password, str) or len(new_password) < 12:
        return api_error("Use a new password with at least 12 characters.", 400)
    with database() as conn:
        user = conn.execute("SELECT * FROM users WHERE id = ?", (g.user["id"],)).fetchone()
        if not check_password_hash(user["password_hash"], current_password):
            return api_error("Current password is incorrect.", 400)
        conn.execute(
            "UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, auth_version = auth_version + 1 WHERE id = ?",
            (generate_password_hash(new_password), g.user["id"]),
        )
        session["auth_version"] = g.user["auth_version"] + 1
        audit(conn, g.user["id"], "password_changed", "user", g.user["id"], "Changed own password.")
    return jsonify({"message": "Password changed."})


init_database()


if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1")
