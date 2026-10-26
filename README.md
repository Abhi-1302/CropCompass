# CropCompass

Crop-rotation decision support built on NASA Earth data (NASA Space Apps 2026, *Field Shift*).
See [docs/PLAN.md](docs/PLAN.md) for the product and technical plan.

- [Presentation and demo guide](docs/PRESENTATION_GUIDE.md): what is ingested, when it runs, readiness states, slide outline and demo script.
- [Research and decision record](docs/RESEARCH_AND_DECISIONS.md): methods, assumptions, 38 design decisions, code references and an evaluation plan.

## Run locally

Backend (Python 3.12+), from `backend/`:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
Copy-Item .env.example .env          # then set DATABASE_URL (SQLite by default, Neon for shared use)
.\.venv\Scripts\alembic.exe upgrade head
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

Frontend (Node 22+), from `frontend/`:

```powershell
npm install
npm run dev                          # http://localhost:5173, proxies /api to :8000
```

Checks: `.\.venv\Scripts\python.exe -m pytest` and `.\.venv\Scripts\ruff.exe check .` (backend), `npm run build` (frontend).

## Email with Mailjet

Password-reset emails use the shared Python mailer in `backend/app/services/mailer.py`; no Node mail service is needed.
Set these values in your ignored `backend/.env` or your backend host's secret environment settings:

```dotenv
MAILJET_API_KEY=<your Mailjet API key>
MAILJET_API_SECRET=<your Mailjet secret key>
MAILJET_FROM="CropCompass <your-verified-sender@example.com>"
PUBLIC_APP_URL=https://your-frontend-domain
```

Verify the sender address or domain in Mailjet first; configure SPF/DKIM for a domain you own. Keep `PUBLIC_APP_URL`
pointing to your local frontend during development. Restart FastAPI after changing environment settings.
Set the display name in deployed `MAILJET_FROM` or `SMTP_FROM` values to `CropCompass`, retaining the verified
sender address. Environment overrides take precedence over the code's default sender name.
The default transport is `in.mailjet.com:2525` with mandatory STARTTLS and certificate verification before login.
Optional `MAILJET_HOST` and `MAILJET_PORT` override the endpoint to match your Mailjet account's SMTP settings.
Never put these credentials in frontend `VITE_*` variables or commit them.

Mailjet takes precedence over generic `SMTP_*` settings when any Mailjet key, secret or sender is set. All three are
required; incomplete settings report password-reset email as unavailable without issuing tokens or logging links.
Without Mailjet, existing SMTP settings still work. With neither provider and `COOKIE_SECURE=false`, local development
continues to log reset links; deployed HTTPS must use `COOKIE_SECURE=true`, which disables that fallback.

Emails are plain text and sent in a background task. The reset response acknowledges a request, not successful
delivery; SMTP failures are logged without message bodies or credentials, and there is no durable retry queue.
Tests mock SMTP and do not send real emails. Verify actual delivery with a password-reset request after configuring Mailjet.

## Neon PostgreSQL

The existing FastAPI/SQLAlchemy backend uses psycopg; the browser never connects to Neon directly.
Only Postgres is enabled in `neon.ts`. Application authentication remains in FastAPI.

From the repository root, after installing the Neon CLI and signing in:

```powershell
npm ci
npm --prefix frontend ci
neon init -y --org-id org-curly-mud-99960939 --project-id super-scene-03741720 --branch production --services postgres --agent vscode
neon deploy
npm run build
```

`neon deploy` provisions database services and pulls credentials; it does not host the frontend or FastAPI.
It writes `.env.local` (or `.env` if one exists). Settings load `backend/.env`, root `.env`, then root `.env.local`,
with later files winning; process environment variables take precedence over every file. Avoid keeping stale
root env files for a different branch. All real env files and `.neon` are ignored by Git.

- `DATABASE_URL`: pooled connection for the API.
- `DATABASE_URL_UNPOOLED`: direct connection for Alembic; falls back to `DATABASE_URL` if omitted.
- Keep Neon's TLS options. Never put either URL in frontend variables or commit them.
- Local SQLite accounts, farms and cached weather are not uploaded by migrations. A new Neon database starts empty.

Apply migrations from `backend/` with `.\.venv\Scripts\alembic.exe upgrade head`, then start FastAPI as above.
From the root, `npm run dev` starts the frontend. Restart FastAPI after switching Neon branches or env files.
For local HTTP only, retain `COOKIE_SECURE=false` in `backend/.env`; deployed HTTPS must use `true`.

The opt-in integration test uses real Neon Postgres but synthetic weather/soil/satellite fixtures. It requires an
already-migrated disposable branch with no weather data and refuses the configured application endpoint. Pull that
branch's credentials into a separate ignored `.env.neon-test` file, leaving the app's root env files unchanged.
From the repository root:

```powershell
$env:CROPCOMPASS_NEON_TEST_ENV = (Resolve-Path .env.neon-test).Path
.\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_neon.py
Remove-Item Env:CROPCOMPASS_NEON_TEST_ENV
```

Normal regression tests remain isolated on SQLite and skip this opt-in test. Never point fixture-based tests at
production. Test migrations on a disposable branch first and take a provider backup before changing a populated database.

The CSV files in the repository root are the original 2024 sample data; they are used only as test fixtures.

## Weather verification and repair

Weather is downloaded in calendar-year windows, checked against POWER monthly rainfall and evaporation rates,
and checkpointed. Failed years are retried with month-sized daily requests. No automatic unit rescaling is applied.
Monthly POWER is a consistency check, not an independent source of meteorological truth.

Migration `0005` marks legacy cells unverified. Climate and crop-fit views require a verified full replacement.
Planning remains available with **Low confidence** when at least 30 consecutive checked complete years through last
December exist for a supported region. It uses checked history and last year's calendar-matched weather as an
explicit recent-state scenario, never the suspect blob. The information icon explains the reference year and replaced
dates; substituted days are excluded from historical outcome trials. Journal and soil editing stay available.
Saved plans retain their weather provenance and warnings even after later repair.

For local SQLite repair, stop API workers first and run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m app.weather_repair --backup-only
.\.venv\Scripts\alembic.exe upgrade head
.\.venv\Scripts\python.exe -m app.weather_repair --audit-only
.\.venv\Scripts\python.exe -m app.weather_repair
```

Use `--cell 18.500_79.375` to retry one cell. Completed historical checkpoints are reused; a failed run exits
nonzero and leaves the published blob unchanged. PostgreSQL requires a provider backup before migration/repair.
Use one API worker for ingestion: job locks and the two-request POWER concurrency limit are process-local.

**23 October 2026:** all five local cells have 1981-2025 checked (225 annual checkpoints), but 2026 GEOSIT evaporation
remains implausible even in a one-day request. Weather cells remain quarantined with no new verified revision published;
India farms can nevertheless open Plan in the labelled historical-scenario mode above.
See [the QA report](docs/QA-2026-10-23.md) for measurements and remaining limitations. Do not bypass verification or
divide values by 24. Retry after upstream correction; switching sources needs separate validation.