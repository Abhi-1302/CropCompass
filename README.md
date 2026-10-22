# AuraFarming

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