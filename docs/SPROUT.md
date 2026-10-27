# Sprout

Sprout is CropCompass's read-only, farm-aware assistant. It explains platform help,
farm and soil summaries, crop history, saved-plan inputs, next-crop options and
rotations. Crop recommendations still come from the existing deterministic planner.
It does not edit farm records, save plans, browse the web, execute code, or provide
pesticide advice. Model-generated explanations can be wrong and require evaluation.

## Enable after migration

An empty `GROQ_API_KEY` placeholder is in the ignored backend environment file.
The public [environment example](../backend/.env.example) contains the same settings:

```dotenv
SPROUT_ENABLED=false
GROQ_API_KEY=
SPROUT_MODEL=openai/gpt-oss-120b
```

1. Install backend dependencies from `backend/` with `python -m pip install -e ".[dev]"`.
2. Test migration `0006` on an isolated database/Neon branch first. Back up a populated
   database before migrating it. From `backend/`, run `python -m alembic upgrade head`.
   PostgreSQL migrations use `DATABASE_URL_UNPOOLED`; normal requests use the pooled URL.
3. Paste your real Groq key into `GROQ_API_KEY`, enable Zero Data Retention in the Groq
   console, and set `SPROUT_ENABLED=true` only when ready to allow model requests.
4. Restart the backend. Install frontend dependencies with `npm --prefix frontend ci`.

Root environment files and process variables override the backend environment file.
Do not duplicate a stale key in another environment file. Never put keys in `VITE_*`
variables, logs, screenshots, source control, or chat messages.

On Render, add these variables in the service's secret environment settings. The existing
start command can run Alembic before Uvicorn. Deploy both services from the same release;
Vercel needs no new environment variables. Its existing `/api/*` rewrite forwards chat
requests to Render. Validate streaming and timeout behavior on the hosted deployment.
Local checks do not prove that the hosted proxy or a particular Groq account quota works.

With `SPROUT_ENABLED=false`, the launcher is hidden. With the feature enabled but no real
key, the launcher can show help/history but AI responses remain unavailable. Existing
chat history, deletion and account export remain accessible even when generation is disabled.
The migration must exist before deploying this backend version, including account export.

## Interface and conversation behavior

- An original transparent sprout mascot opens the assistant from signed-in screens.
  Desktop uses a compact panel; mobile uses a full-screen dialog. Escape closes it and
  restores focus. Closing does not erase the draft or saved history.
- New conversations are either platform help or bound to one farm. Switching farms
  does not retarget an existing conversation. History is private to the account.
- Ask Sprout on a crop or rotation view passes the selected IDs, temporary scenario
  inputs and viewed weather revision. The backend validates/recalculates actual results.
- Hypothetical irrigation, season, weights and residue remain chat-only overrides.
  Reset scenario returns to saved farm defaults; it does not change farm records.
- The first send requires acknowledgement that messages and limited context go to Groq.
  Sprout excludes account identity, exact coordinates, raw climate blobs and journal
  free-text notes from its automatic farm context. A user's own message may still contain
  sensitive details, so the interface asks users not to submit those details.
- All UI controls are available in English, Hindi and Telugu. The model is instructed
  to answer in the selected language. Source passages remain in their curated language;
  native-language and agronomic review is still required before broad farmer use.
- Numerical cards and confidence notices use backend evidence. Rotation income and
  irrigation are annualized, not totals for the two-year sequence. Historical/proxy
  warnings are never upgraded into observations or forecasts by the chatbot.

## Context and knowledge

The versioned [knowledge base](../backend/app/knowledge/sprout.json) is packaged with
the backend. It describes implemented features rather than future product proposals.
Each section has an ID, title, tags, multilingual search aliases, text and version.
Retrieval selects at most three keyword-ranked sections; no paid embeddings or vector
database is required. Review this file when capabilities or data assumptions change.

A turn uses at most two model calls: structured intent/scenario resolution, followed by
a streamed explanation. Explicit starter/Ask Sprout intents can skip the resolution call.
Only allowlisted backend services execute; the model cannot choose a user or farm ID.
The adapter is separate from orchestration so another provider can be added later.

Each prompt includes trusted behavior rules and a bounded untrusted context payload:
recent completed exchanges, explicit scenario state, an extractive summary of older
user questions, previously displayed option IDs, selected help passages and fresh facts.
No permanent cross-conversation profile is created. Older messages remain in Neon for
display/export. Partial failed answers are excluded from subsequent conversation context.

The prompt budget drops older chat and optional passages before it drops required
confidence information. If required evidence cannot fit, generation fails honestly.
Evidence stores timestamps, input fingerprints, weather provenance, KB/engine versions
and scenario information. Changed inputs are flagged; previous answers remain snapshots.
Source IDs are validated before saving a completed answer, but citations alone do not
guarantee that every generated sentence is factually correct. Partial streamed text is
provisional until completion.

## Persistence and limits

Migration [0006](../backend/migrations/versions/0006_sprout_chat.py) adds:

| Table | Purpose |
| --- | --- |
| `chat_threads` | Owner, optional farm, language, scenario, summary and version |
| `chat_messages` | Ordered user/assistant messages and bounded answer evidence |
| `chat_runs` | Idempotent generation attempts, state, lease, cancellation and token accounting |
| `chat_usage_daily` | Durable per-user and global UTC-day request/token budgets |

Account deletion cascades through chat records; farm deletion removes its bound threads.
Deleting a thread does not reset daily usage. Global daily counters are retained without
user content. Account export includes conversations, but no provider credentials or private
reasoning traces. Failed runs store generic error codes, not provider error bodies.

Defaults are configurable through backend environment settings:

| Variable | Default |
| --- | --- |
| `SPROUT_DAILY_REQUESTS` | 20 per user |
| `SPROUT_GLOBAL_DAILY_REQUESTS` | 100 |
| `SPROUT_DAILY_TOKENS` | 40000 per user |
| `SPROUT_GLOBAL_DAILY_TOKENS` | 180000 |
| `SPROUT_MAX_CONCURRENT` | 2 globally; one active run per thread |
| `SPROUT_MAX_THREADS` | 30 per user |
| `SPROUT_MAX_TURNS` | 100 user messages per conversation |
| `SPROUT_MAX_OUTPUT_TOKENS` | 1500 for the explanation, including model reasoning; resolution is capped separately |
| `SPROUT_CONTEXT_CHARS` | 14000; enforced conservatively as a UTF-8 byte budget per prompt |
| `SPROUT_TIMEOUT_S` | 60 per provider call |

There is also a short burst limit of six send attempts per minute per user. Set budgets
to the actual Groq organization's limits; free limits are shared across the whole app.
Tokens are conservatively reserved before calls, then reconciled from reported usage.
When usage is unknown after an interruption, reservations stay charged for that UTC day.
This favors preventing unexpected consumption over maximizing the free allowance.
No paid model/provider fallback occurs. Public help can be read when generation is unavailable.

The MVP has size/count caps and explicit deletion, not automatic time-based transcript
expiry. Add a documented retention policy and scheduled purge before a wider production rollout.

## Streaming and interruption

The authenticated POST stream reuses session cookies and CSRF protection. Events include
`started`, `status`, `evidence`, `delta`, `done`, `error` and `existing`. The frontend uses
a maintained SSE parser with streaming UTF-8 decoding. No database transaction is held
open while waiting on Groq. Final messages are committed before `done` is emitted.

Unique request IDs prevent duplicate generations. Conversation versions reject stale
tabs. Stop and disconnects attempt to terminate generation; partial text is not saved as
a completed answer. Runs left behind by a crash expire on their lease and are marked
interrupted when read. Retry creates a new attempt for the latest failed user message,
preserving its original scenario rather than adding a duplicate user message.

Render Free may sleep or restart. This implementation deliberately does not promise
background completion or transparent continuation across a restart. A durable worker
queue would be the next step if those guarantees become necessary. Disable the feature
flag to roll back exposure; do not drop conversation tables containing user history.

## Validation and isolated preview

From the repository root:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider backend/tests -k "not test_neon_persistence_advice_and_account_cleanup"
.\backend\.venv\Scripts\ruff.exe check backend
.\backend\.venv\Scripts\ruff.exe format --check backend
npm run build
npm run check:locales
npm --prefix frontend run test:sprout
```

Tests mock model/network interactions, exercise migrations on temporary SQLite, and
compile PostgreSQL migration SQL without connecting to a server. Real Neon migration
testing and actual Groq behavior remain separate deployment gates. No live password-reset
or real-email test is required by these checks.

For UI review without a real key or production data:

```powershell
.\backend\.venv\Scripts\python.exe -m uvicorn tests.sprout_preview:create_preview_app --factory --app-dir backend --host 127.0.0.1 --port 8000
```

In another terminal, run `npm --prefix frontend run dev`. The preview factory uses
temporary SQLite, synthetic environmental sources and a clearly labelled fake model.
Its disposable login is `sprout.preview@example.com` with password `sprout-local-preview`.
Bind it only to loopback; never deploy this test factory. Stopping it removes its database.
The production backend remains `app.main:app` and never uses the preview factory.

The mascot is an original generated bitmap. Its reproducible Windows drawing script is
[draw-sprout.ps1](../frontend/scripts/draw-sprout.ps1); the PNG is shipped as a static asset.

## Live QA: 27 October 2026

Tested the local Vite application against the normal FastAPI backend, real Neon and Groq,
using a disposable account and a public Telangana demo location. This was not the synthetic
preview factory and does not constitute a hosted Render/Vercel acceptance test.

Eight generation attempts produced six saved responses and two failures before corrections.
Reported token usage was 24,302; one truncated attempt did not report final usage and retained
its conservative reservation. No password-reset or real-email workflow was tested.

- Confirmed consent enforcement, English platform help, follow-up context, persisted history
  after reload, farm-specific data-readiness handling, Hindi soil explanations and a Telugu
  planner-backed answer. The Telugu retry retained its original full-irrigation scenario;
  its three displayed crop figures matched the planner's response exactly.
- Fixed a blank-message interval between stream completion and slow database-history refresh.
- Added explicit soil units/provenance after a live answer confused mm/m with volume units
  and described an estimated depth as a measurement. The fresh Hindi retest used the correct
  units and estimation caveat. This is sample-based validation, not a guarantee of factuality.
- Corrected explicit-intent requests to reserve one model call rather than two. Output-limit
  handling now consumes final usage metadata before reporting truncation. The output default
  is 1500 tokens to accommodate multilingual responses and internal model reasoning.
- Normalized alternate citation brackets and removed old source markers from follow-up history.
  Current allowed source IDs are explicit. Ranking evidence now includes actual pillar scores
  and reasons instead of leaving the model to infer why an option ranked first.
- After explicit approval, two final live retests used a temporary process-only local user
  quota increase. The normal 40,000-token limit was restored, with no environment-file changes
  and no resets of actual global usage accounting.
- Deleted the disposable account, farm and conversations; the original account was preserved.
  The shared public weather cache was retained for reuse. The browser was left signed out.

Generated prose can still over-explain or suggest unsupported follow-ups; prompts and evidence
reduce this risk but do not eliminate it. Native-language review, agronomic validation and a
broader evaluation set remain required before relying on Sprout for operational decisions.
