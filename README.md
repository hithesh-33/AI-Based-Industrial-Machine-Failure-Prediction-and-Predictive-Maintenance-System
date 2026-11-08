# Predictive Maintenance Monitor

A local Flask + scikit-learn prototype for a manufacturing maintenance dashboard.

## What it includes
- Six demo machines with sensor readings and status cards.
- Random Forest classifier trained from `dataset/ai4i_sample.csv`.
- First-launch administrator setup, password-hashed sign-in, and administrator/operator/viewer access roles.
- SQLite-backed machine sensor history, failure probability, health score, and sensor trend charts.
- Persistent maintenance alerts with acknowledgement, resolution, and a timestamped activity history.
- Persistent preventive-maintenance due dates, in-app reminders for due or overdue machines, and completion history. Completing due maintenance advances the next due date by seven days.
- Maintenance work orders with priorities, assignees, due dates, status, and completion notes.
- Rule-based AI root-cause suggestions, sensor flatline/step-change/telemetry-gap checks, and line-level production exposure scenarios.
- Alert-driven maintenance work-order generation with duplicate prevention, role enforcement, and audit history.
- Weekly maintenance plan and machine maintenance history.
- Manual sensor inputs and a **Run prediction** action.

> Dataset note: the included CSV is a deterministic illustrative sample dataset, not the official AI4I 2020 dataset. The model is genuinely trained on that CSV; it does not return random labels. For a formal evaluation, replace the CSV with the official AI4I dataset and map its features to the five dashboard features.
>
> The initial sensor timeline is seeded with illustrative demo history. New demo telemetry is saved at most once every five minutes; manual prediction inputs are saved separately and do not replace the machine's latest telemetry. Review the data source and validate the model before operational use.

## Windows setup
1. Install Python 3.10 or newer.
2. Extract the ZIP and open the project folder in VS Code.
3. Open Terminal / PowerShell in the project folder.
4. Create and activate a virtual environment:
   ```powershell
   py -m venv .venv
   .venv\Scripts\activate
   ```
5. Install dependencies:
   ```powershell
   pip install -r requirements.txt
   ```
6. Train the model:
   ```powershell
   python backend\train_model.py
   ```
7. (Optional) Enable the Gemini-powered assistant by setting your key in the same PowerShell window; keep it private and do not add it to source files:
   ```powershell
   $env:GEMINI_API_KEY = "your-Gemini-API-key"
   ```
   ForgeSight uses `gemini-2.5-flash` by default. To choose another available model, set `GEMINI_MODEL` before starting the app. The key stays on the server and is never saved in browser settings.
8. From the project root, start the website:
   ```powershell
   python backend\app.py
   ```
9. Open `http://127.0.0.1:5000` in Chrome. On first launch, create the initial administrator account. Use a unique password with at least 12 characters.

Keep the terminal open while demonstrating. If you change the dataset, run `python train_model.py` again.

## Accounts and access
- **Administrator:** manage user accounts and roles; manage alerts and work orders.
- **Maintenance operator:** acknowledge/resolve alerts and create/update work orders.
- **Viewer:** read-only access to the dashboard, alerts, history, and work orders.
- Operators and administrators see in-app notifications for active alerts when they sign in and when new alerts are detected; the alert badge also refreshes automatically.
- Administrators create accounts in **User Management** and set a temporary initial password (at least 12 characters). Share it securely; users can change their password in **Settings**.
- Sign out using the account button at the bottom of the sidebar. After five failed sign-in attempts, that account is temporarily locked for 15 minutes.

## Persistent data and deployment
- SQLite data is stored in `instance\forgesight.sqlite3`; the local Flask session-signing key is stored in `instance\.secret_key`. Back up the database before replacing it or moving the app.
- Set `FORGESIGHT_SECRET_KEY` to a strong, private value when deploying or using multiple app instances. For HTTPS deployments, set `FORGESIGHT_SECURE_COOKIE=1`.
- The included Flask development server is for local demonstration only. Use a production WSGI server, HTTPS, a managed secret, and regular database backups before any real deployment. Do not expose the demo telemetry or model as operational guidance without validation.
- `GEMINI_API_KEY` is optional and must be configured as a server environment variable. Gemini receives the current fleet sensor snapshot and the user's assistant question; do not send confidential production data unless your organization's Google AI terms and data policies permit it. Without a key, the assistant reports that it is not configured.

## Demo flow
1. Open the dashboard and point out total machines and current risk distribution.
2. Click a machine card to open its detailed sensor and maintenance view.
3. Review saved sensor trends, last maintenance and weekly plan.
4. Edit sensor values (for example, raise vibration and temperature) and run a new prediction.
5. Create a work order, assign it to an operator, and update its status or completion notes.
6. Acknowledge and resolve an alert, then review the alert activity history.
7. Review Root Cause Analysis for transparent signal checks and recommendations. Sensor diagnostics are not exposed as a separate navigation page.
8. Use Production Impact to compare current line exposure and severity-based downtime scenarios, then generate work orders for active alerts.
9. Explain that the Random Forest model estimates failure probability from the five input readings. The analytics are decision-support suggestions, not guaranteed diagnoses; impact windows are illustrative and do not estimate actual output or financial loss.

## Project structure
```
predictive_maintenance_prototype/
├── backend/
│   ├── app.py
│   └── train_model.py
├── dataset/
│   ├── ai4i_sample.csv
│   └── README.txt
├── frontend/
│   ├── templates/index.html
│   └── static/
│       ├── css/style.css
│       └── js/app.js
├── models/                 # trained model saved here after training
├── requirements.txt
└── README.md
```
