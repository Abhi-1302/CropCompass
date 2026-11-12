# Continue as Guest: Feature and Implementation Plan

Status: implemented locally on 2026-11-12; production rollout pending. Original design written 2026-11-07.

## Implementation and Local Verification

The implementation adds migration `0007_guest_access.py`, constrained guest
identities, durable admission/resource budgets, normal cookie/CSRF authentication,
30-day inactivity retention, renewal checkpoints, UUID-preserving conversion,
guest export/deletion, and a dry-run-first cleanup CLI. Guest creation is disabled
by default. The login/account/header flows are translated into English, Hindi,
and Telugu. Regular account password checks remain required.

Completed verification: isolated backend regression suite; populated SQLite
upgrade/downgrade preserving registered users and sessions; PostgreSQL migration
SQL compilation (not a live PostgreSQL migration); concurrent SQLite quota test;
guest lifecycle, ownership, retention/cleanup, disabled-creation, and mocked
Sprout streaming/usage tests; frontend typecheck, production build and translation
checks. Browser testing uses the normal application with an isolated local SQLite
database, not the configured shared PostgreSQL database.

In the integrated browser, guest creation/reload, farm creation, journal entry,
next-crop planning, stress testing, rotations, plan saving, export, same-ID account
conversion and subsequent password login were exercised. Exported farms, journal,
plan and conversation records matched before and after conversion. A second guest
could not access the first guest's farm (404). One real Sprout attempt reached the
streaming endpoint but the provider returned unavailable; mocked guest streaming
passes. Do not treat this as successful live-provider acceptance. SoilGrids failed
during this local farm build and the labeled standard-soil fallback was used.

The local database is the ignored `backend/guest-local.db`. Only one public NASA
weather cell and its annual checkpoints were copied for testing; no original
users, farms, histories, plans, or conversations were copied or modified. The local
runtime overrides `DATABASE_URL`, `COOKIE_SECURE=false`, `GUEST_ENABLED=true` and
a process-only generated `GUEST_ABUSE_HMAC_KEY`. These overrides are not saved to
the existing environment files. The process uses `--no-proxy-headers` on loopback.
For reproducible local configuration, set an independent persistent guest abuse
key in an ignored environment file yourself; do not use the test-fixture key.

### Deploying This Version

1. Rehearse migration `0007` and concurrent cleanup/conversion on an approved,
  disposable PostgreSQL branch. The guarded opt-in `test_neon.py` now expects
  revision `0007`; never point it at the application database.
2. With creation still disabled, back up and apply `python -m alembic upgrade head`
  from `backend/`, using the direct migration URL. Deploy backend and frontend
  together; all workers must understand guest rows before enabling creation.
3. Configure an independent `GUEST_ABUSE_HMAC_KEY` of at least 32 characters. Keep
  `COOKIE_SECURE=true` in production. Verify the trusted proxy/client-IP chain,
  then explicitly set `GUEST_PROXY_VERIFIED=true`; do not blindly trust forwarded
  headers. Only then set `GUEST_ENABLED=true`.
4. Configure a daily scheduler (suggested 03:00 UTC) for
  `python -m app.guest_cleanup --execute --batch-size 100 --max-batches 20` from
  `backend/`. A dry-run omits `--execute`. Exit 1 means failure; exit 2 means
  remaining backlog. Structured output reports deletions, batches, remaining
  expired users, oldest-expired age, and runtime without private data.
5. Configure alerts for failures/missed runs and deletion lag. No Render service,
  schedule, paid infrastructure, backup policy, or alert integration was created
  by this implementation. The API denies expired access without depending on cron.
6. Verify hosted cookies, client-IP attribution, cold starts, quota behavior,
  live Sprout, and PostgreSQL race tests before public release. Keep retention
  promises aligned with the actual scheduled job and backup/provider policies.

Implementation notes: the expiry checkpoint writes only after the configured
interval and aligns cookies with the stored deadline. Conversion and activity
requests are serialized within a tab; cross-tab identity events clear private
caches and cancel in-flight requests. Guest login/register replacement is rejected
until the guest explicitly ends their session or converts. Guest deletion removes
private children but retains global/short-lived network budgets and shared weather.
The cleanup command prunes expired network counters and does not erase provider
budget history. `GUEST_ENABLED=false` stops creation, not existing guest access,
conversion, export, deletion, or cleanup.

The remaining numbered sections preserve the design and acceptance checklist;
unchecked gates should not be read as deployment certification. User-specified
limits are configuration, and the proposed ceiling still needs production storage
measurement. Schema rollback is refused while guest users or active guest runs
exist. Disabling creation is the first operational rollback; do not deploy an old
backend that assumes every user has credentials.

This document defines the product behavior, implementation, safeguards,
and release gates for guest access in CropCompass. It does not authorize a live
database migration, account deletion, infrastructure provisioning, or deployment.
Defaults below are implemented behind the feature gate; production rollout needs
the separate environment and operational approvals listed above.

## 1. Goal and boundaries

Let someone choose **Continue as guest**, use the normal application with private
data, and later choose **Create account to keep your data** without starting over.

A guest is a server-side user with a private UUID and an opaque session cookie,
not a shared demo account and not an unauthenticated exception to authorization.
All farms, journal records, plans, and conversations remain owned and protected.
Use the existing FastAPI, SQLAlchemy/Alembic, PostgreSQL, React, and cookie-auth
stack. Do not introduce another identity provider or move data into localStorage.

Full feature access means access to the same workflows, not unlimited resources
or guaranteed availability. Region support, data readiness, model warnings,
Sprout consent, provider availability, and usage limits still apply.

Out of scope for the first release:

- Merging guest data into an already registered account.
- Guest recovery links, anonymous cross-device login, or email notifications.
- OAuth, a new email-verification system, and changes to regular-account retention.
- A shared demonstration farm, preloaded private data, or synthetic farmer history.
- Changes to the crop engine, environmental-data validation, or Sprout reasoning.

## 2. Current implementation and implications

These observations come from the source code, not from a live database inspection.

| Existing behavior | Implementation implication |
| --- | --- |
| [User](../backend/app/models.py) requires email, password hash, and name. | Support nullable credentials for guests with a database constraint enforcing valid identity states. Do not invent fake email addresses or shared passwords. |
| Farms and chat threads reference `users.id`; child records have cascading foreign keys. | Keep the UUID on conversion. No data copying or reassignment is needed. Verify actual migration cascades on both supported databases. |
| [current_session/current_user](../backend/app/deps.py) validate a stored session, and `owned_farm` checks the owner. | Add guest expiry validation to the shared authentication path; retain every ownership check. |
| [_start_session](../backend/app/routers/auth.py) commits and sets both cookies. | Separate session-row preparation from transaction commit and cookie issuance before using it for atomic conversion. Preserve existing login/register behavior. |
| [Account deletion](../backend/app/routers/account.py) requires a current password. | Add a separate, authenticated guest-delete operation. Do not weaken regular-account password confirmation. |
| [Account export](../backend/app/routers/account.py) includes farms, journal, plans, and chat exports. | Allow guest export, represent absent email honestly, and expose guest expiry without exposing session or abuse-control secrets. |
| Shared climate cells and weather-year checkpoints are not owned by a guest. | Account deletion must not delete shared environmental caches. |
| [Settings](../backend/app/config.py) default sessions to 14 days. | A 30-day guest policy needs a guest-specific session lifetime and coordinated cookie renewal, not a global regular-session TTL change. |
| [RateLimiter](../backend/app/ratelimit.py) is explicitly per process. | Restarts and multiple workers reset/split most existing limits. Public guest creation needs durable counters. |
| [Sprout reservations](../backend/app/services/sprout.py) already enforce database-backed user/global daily budgets. | Extend these budgets, including their settlement logic, instead of adding a frontend-only chat allowance. |

## 3. Product policy

### 3.1 Retention and access

Recommended initial policy:

- Guest data expires after **30 days of inactivity**.
- Display the server-provided expiry date and a persistent account-creation action.
- Emphasize the expiry warning when **7 days or fewer** remain.
- At the exact expiry timestamp, deny protected access and conversion, even if the
  cleanup job has not deleted the rows yet. Do not silently revive an expired guest.
- Delete expired guests from the active database on a daily schedule. Target
  deletion within 24 hours of expiry during normal operation; alert on delays.
- No automatic email warning: a guest has not supplied an email address.
- Clearing cookies, using private browsing, signing out, or losing the browser
  profile can make guest data inaccessible before the retention deadline. Warn
  about this before guest creation and before ending a guest session.
- Closing and reopening the same browser may resume a still-valid persistent
  session. The cookie is access to the guest identity, not proof of a person.

This is an inactivity policy, not a hard maximum lifetime. An actively used guest
can remain a guest, subject to resource limits. A hard lifetime cap would be a
separate product decision and must not be added silently.

### 3.2 Meaningful activity

Use a dedicated CSRF-protected `POST /api/v1/auth/guest/activity` checkpoint.
Send it on an intentional return to the foreground or user navigation/interaction,
at most once per 15 minutes while there is actual foreground activity. Do not
send an unconditional interval heartbeat. Initial guest creation is activity too.

- Validate the session and unexpired guest before accepting a checkpoint.
- Under a short transaction, record UTC server time and set expiry to that time
  plus the retention period; do not accept a client-supplied timestamp or deadline.
- Coalesce database writes within the 15-minute window. Return the authoritative
  deadline even when no extension was needed; the UI displays that deadline.
- Routine `/auth/me` calls, query polling, background tabs, weather jobs, and a
  running chat stream do not themselves keep a guest alive.
- This checkpoint is a retention mechanism, not proof of human activity. A bot can
  call it too; creation, storage, compute, and provider budgets remain necessary.
- Session expiry and cookie lifetime must extend together with accepted activity,
  never beyond the guest's data expiry. Otherwise an active guest could lose the
  only credential that can access still-retained data.
- Return expiry and warning metadata on `/auth/me`; do not rely on the client clock
  to grant access. A request at or after expiry receives a stable expiry error.

The recorded checkpoint can lag a user's latest action by up to the coalescing
window. Product copy should say "after 30 days of inactivity" and show the actual
server deadline, rather than promising second-accurate tracking of every click.

### 3.3 Feature access

| Capability | Guest behavior |
| --- | --- |
| Create, edit, and delete farms; map boundaries and soil inputs | Available, subject to disclosed resource limits. |
| Crop history, climate, vegetation, crop fit, field view | Available under the same region and data-quality rules. |
| Next-crop advice, rotations, stress tests, saved plans | Available; private to the guest identity. |
| Sprout conversations, history, stop/retry, and evidence | Available when enabled; explicit AI consent and bounded usage apply. |
| Export and delete own data | Available without inventing a guest password. |
| Create a permanent account with a new email | Convert in place, preserving all owned records. |
| Password change/reset and another-device password login | Available only after conversion. |
| Existing-account sign-in | Available with a clear warning that it does not merge or preserve guest access. |

## 4. Identity and schema design

Extend the existing `users` model instead of creating parallel guest ownership
columns on every farm or chat table.

| Field | Proposed definition |
| --- | --- |
| `is_guest` | Non-null boolean, default false; existing accounts stay registered. |
| `email` | Nullable for guests; retain the unique index for registered addresses. |
| `password_hash` | Nullable for guests; Argon2id for registered accounts as today. |
| `name` | Keep required; a neutral stored guest name, localized as "Guest" in the UI. |
| `guest_last_active_at` | Nullable UTC timestamp; required for a guest. |
| `guest_expires_at` | Nullable UTC timestamp; required for a guest and indexed for cleanup. |
| `registered_at` | Nullable UTC timestamp; set on conversion/new registration. Existing rows can be backfilled from `created_at`. |
| `created_at` | Preserve the original identity creation timestamp through conversion. |

Add a named check constraint with two valid states:

1. Guest: `is_guest = true`, credentials null, both guest timestamps non-null,
   expiry later than last activity, and `registered_at` null.
2. Registered: `is_guest = false`, credentials non-null, guest timestamps null,
   and `registered_at` non-null.

Use explicit `IS NULL`/`IS NOT NULL` conditions so SQL's null semantics cannot
accidentally bypass the constraint. Email normalization and password policy remain
in the existing registration validation. PostgreSQL and SQLite both allow multiple
null values under the current unique-email design; test both migration paths.

Use an index on `(is_guest, guest_expires_at)` or an equivalent supported partial
index after assessing the migration conventions. Do not change any existing UUID
or owner foreign key. Ancillary abuse counters and cleanup telemetry are described
later and are not part of an individual guest's content ownership.

## 5. Lifecycle and transaction rules

### 5.1 Guest creation

The login-page action creates a guest and its initial session atomically, then
issues the normal HttpOnly session cookie and readable CSRF cookie. Keep the
existing Secure-in-production, SameSite=Lax, same-origin API design.

An existing valid guest session should resume the same identity, not create another
one or reset its quotas. An existing regular session must never be downgraded or
overwritten by this endpoint. Disable duplicate UI submissions, rate-limit creation,
and do not automatically retry an ambiguous create timeout in a loop.

### 5.2 Convert guest to registered account

Expose a dedicated authenticated conversion endpoint instead of silently making
public registration mutate whichever cookie happens to be present.

1. Validate Origin, CSRF, a live session, registration fields, and conversion rate
   limits. Require the current identity to be an unexpired guest.
2. Normalize the email using the existing rules; enforce the existing password
   length and email-as-password rules. Hash the password before taking a long-lived
   database lock; do not log the request body.
3. Begin a short transaction and lock/reload the user. Recheck guest state and expiry
   with fresh server time, not the ORM object cached before lock acquisition.
4. Set email/name/hash and `registered_at`; clear guest timestamps and set
   `is_guest = false`. The unique-email constraint is authoritative in concurrent
   requests. On conflict, roll back everything and return a conflict response.
5. Revoke all old sessions for this UUID and insert a fresh registered-account
   session in the same transaction. Use new session and CSRF tokens.
6. Commit once, then set the new cookies and return the updated user. Never issue
   successful cookies before the transaction commits.
7. Refresh the frontend identity and guest UI. Farm, plan, history, and chat IDs
   remain unchanged. Preserve usage accounting, including already consumed Sprout
   allowance; account creation is not a quota-reset mechanism.

On validation, duplicate-email, hashing, or database failure, the guest and its data
remain intact. If the commit succeeds but the HTTP response is lost, the user can
sign in with the new credentials; do not try to reverse a completed conversion.
Two simultaneous conversions must yield at most one successful transition.

An email already belonging to another account yields a conflict and leaves the
guest untouched. Offer a different email or an explicit switch-account flow. Do
not transfer data on the basis of knowing an email address. A future merge requires
authentication of both identities and its own conflict-resolution specification.

The current app does not have a general email-verification flow. Preserve that
behavior for this scope, but never describe conversion as proof of email ownership.
Requiring email verification would need a separate pending-conversion design.

### 5.3 Cleanup versus activity/conversion

Cleanup, activity renewal, and conversion must serialize on the same user row.
Cleanup rechecks `is_guest = true AND guest_expires_at <= now` under that lock;
conversion and activity recheck `guest_expires_at > now` under their lock.

- A committed conversion prevents cleanup from deleting that identity.
- A committed valid activity renewal causes cleanup to skip the guest.
- A deletion that wins prevents later activity or conversion from recreating it.
- Never delete based only on IDs selected earlier without a locked recheck.
- Keep locks short. Do not hold them during password hashing, network requests,
  weather downloads, or an entire streamed model answer.
- Use a PostgreSQL locking strategy and a separately tested SQLite transaction
  strategy; SQLite does not provide equivalent `SELECT FOR UPDATE` row locks.

## 6. Retention and deletion implementation

Implement one guest-lifecycle service for state checks and transactional deletion,
reused by a guest-delete API and a standalone cleanup command. Do not call the
password-confirmed account-delete HTTP endpoint from a cron job.

The proposed command, `python -m app.guest_cleanup`, does not exist yet. Design it
to default to dry-run and require an explicit `--execute` flag to delete. Support
bounded batch size and maximum batches, counts-only output, and a nonzero exit
code on failure. Process guests in expiry/ID order; commit small batches and make
repeated execution harmless. PostgreSQL workers can use `FOR UPDATE SKIP LOCKED`.
Do not delete all expired rows in one unbounded transaction.

Deletion must remove, through verified foreign-key cascades:

- The guest user, all sessions, and any password-reset rows.
- Owned farms, soil profiles, vegetation series, season records, and saved plans.
- Farm-scoped and platform-scoped chat threads, messages, and runs.
- Per-user chat usage rows where the existing user foreign key requires deletion.

Deletion must preserve:

- Every other user's records, including regular accounts and active guests.
- Shared climate cells and validated weather-year checkpoints.
- Global provider-budget accounting and short-lived aggregate abuse counters
  needed to stop delete/recreate quota bypass.

Background weather/vegetation/chat work must tolerate a missing owner/farm/run,
stop owner-specific writes, and never recreate deleted content. Shared public
weather caching can finish only if it cannot restore private data. Define and test
cancellation/accounting for in-flight model requests before enabling cleanup.

The deletion promise is for active application storage. Backups, logs, database
restore windows, and third-party AI retention are separate policies. Do not claim
instant erasure from every backup or from a provider. Before launch, document those
retention periods and a restore procedure that reapplies expired-guest cleanup.

## 7. API and authentication contracts

All paths below are under `/api/v1`. These are proposed contracts, not existing
endpoints unless explicitly identified. No endpoint accepts an owner ID or guest
expiry from the browser.

| Endpoint | Contract |
| --- | --- |
| `GET /auth/capabilities` (new) | Public, no-store response exposing guest-creation availability, retention/warning periods, and public limits. Never expose private keys, internal abuse keys, or another user's state. |
| `POST /auth/guest` (new) | JSON request; 201 plus `UserOut` and cookies for a new identity, 200 for resuming a valid guest with valid CSRF, 409 `already_signed_in` for a regular session. Check an existing session before creation limits. |
| `POST /auth/guest/activity` (new) | Current guest plus CSRF; 200 with current `UserOut` and renewed cookies when applicable. Reject expired sessions/guests; 409 for a regular identity so the UI refreshes `/auth/me`. |
| `POST /account/convert-guest` (new) | Current guest plus CSRF; body reuses `RegisterIn` (`name`, `email`, `password`). 200 with registered `UserOut` and rotated cookies. 409 for duplicate email/already converted; 422 for field validation. |
| `POST /account/guest/delete` (new) | Current guest plus CSRF and a required literal `confirm: true`; 204 and cleared cookies after transactional deletion. Reject regular users even if they submit this body. |
| `GET /auth/me` (existing) | Add guest state/expiry; return 401 on inactive identity or expired session. Keep the same endpoint for both kinds of user. |
| `POST /auth/logout` (existing) | Keep session revocation and cookie clearing; require guest confirmation in the UI. Logout does not immediately delete server data. |
| `GET /account/export` (existing) | Include identity kind, null email for guests, and expiry. Propose export format version 2 because `account.email` becomes nullable; preserve the remaining data structure. |
| Password change/reset and password-confirmed deletion (existing) | Require a registered identity, safely handling nullable credentials. Forgot-password stays enumeration-resistant and sends nothing for a guest. |

Extend backend `UserOut` and the frontend `User` type with `is_guest`, nullable
`email`, nullable `guest_expires_at`, and a server-computed
`guest_expiring_soon` boolean. Registered responses have null expiry and false
warning. A response builder can combine stored fields with computed metadata;
do not persist the warning boolean. Use a TypeScript discriminated union if it
keeps credential-dependent UI branches type-safe.

Keep error `detail` as a stable string code for new guest errors, matching what
the existing [API client](../frontend/src/api/client.ts) can already read. Translate
known codes in all locales. Suggested codes: `guest_expired`, `guest_unavailable`,
`guest_creation_limited`, `guest_capacity_reached`, `already_registered`, and
`guest_required`. Distinguish invalid/missing session (401), CSRF/Origin rejection
(403), state conflict (409), validation (422), throttling (429), and unavailable
infrastructure/creation feature (503). Return `Retry-After` for timed limits.

### 7.1 Bootstrap, session, and CSRF security

- First-time creation cannot require a CSRF token that does not exist yet. Require
  a JSON request and an allowlisted `Origin` on the new bootstrap endpoint. Reject
  missing Origin there instead of silently inheriting the existing middleware's
  optional-Origin behavior. Verify this through the actual Vercel/Render proxy.
- Any existing valid session on guest creation must pass the normal CSRF check.
  This prevents a cross-site request from swapping an identity in the browser.
- If a stale cookie is present, return 401 and clear invalid cookies before a
  separate, intentional new-guest attempt. Do not promise recovery of the old UUID.
- Keep `af_session` opaque, random, HttpOnly, stored only as a hash server-side;
  keep `af_csrf` readable by the client and validate `X-CSRF-Token` server-side.
- Initial guest sessions use the retention deadline, not the regular 14-day
  default. Activity updates the current session's database deadline and both
  cookies' Max-Age together; other sessions never outlive guest retention.
- Coalesced activity calls should reissue expiry-aligned cookies when needed so
  an earlier lost response cannot leave the browser cookie expiring before its
  server session. Do not rotate session/CSRF tokens on every checkpoint.
- Validate expiry in `current_session` as well as `current_user`, since logout
  and other routes can depend on a session alone. Clear local state on expiry.
- On conversion, revalidate the session under the user lock before revoking old
  sessions. Concurrent activity must not restore stale cookies after conversion:
  serialize identity-changing/checkpoint operations in the frontend and test
  cross-tab response ordering. Stale tokens must remain rejected server-side.
  If a late response from another tab overwrites the new cookies despite UI
  coordination, treat it as a recoverable sign-in requirement, never as permission
  to accept a revoked token. The converted data remains accessible by password.
- Restrict login/register while a valid guest is present unless the UI has
  explicitly confirmed ending that session. Registration should guide guests to
  conversion; an API guard prevents accidentally orphaning their data.
- A first-request retry without any successful cookie can create another guest;
  rate-limit this and let abandoned identities expire. Do not recover an identity
  from a farm ID, email guess, IP address, or browser fingerprint.

### 7.2 Existing ownership and expensive operations

Keep `RequireAuth`, `CurrentUser`, `owned_farm`, and `owned_thread`; a guest passes
authentication but never bypasses authorization. Route handlers must derive the
owner from the session, not a body/query UUID. Foreign resources still return 404.

Revalidate expiry/session state immediately before reserving expensive work and
before private writes. In particular, Sprout's `begin_run` opens its own database
session, and `active_run` currently checks the session but not guest expiry. Carry
the necessary session identity into those checks and stop generation at expiry.
An already-sent response cannot be recalled, but expiry must block subsequent work
and persistence. Adopt a consistent user-before-child lock order for guest writes,
conversion, and deletion, and test for deadlocks with chat completion.

## 8. Usage limits and abuse protection

### 8.1 Proposed initial limits

These are conservative launch defaults to tune using staging tests and expected
traffic, not guarantees of a fixed number of successful model answers.

| Control | Proposed default |
| --- | --- |
| Guest creation per trusted client-network key | 5/hour and 20/UTC day. |
| Guest creation across the deployment | 100/UTC day; hard ceiling of 1,000 retained guest identities, including pending cleanup. |
| Farms per guest | 3, compared with the current regular-account default of 20. |
| Guest journal and saved-plan storage | 200 journal entries and 50 saved plans per farm; keep editing/export/deletion available at the limit. |
| Guest-triggered environmental-data builds | 2/hour and 6/UTC day per guest; 50/day across all guests. Apply to first-build and refresh/resume entry points, not cached reads. |
| Sprout per guest | 6 send attempts/day and 40,000 reserved/settled tokens/day. |
| Sprout across guests | 30 send attempts/day and 80,000 reserved/settled tokens/day, additionally constrained by the existing application-global budget. |
| Guest Sprout sends per trusted client-network key | 20/day across recreated guest identities. |
| Other Sprout limits | Preserve thread/turn, message size, burst, concurrent-run, timeout, and privacy restrictions. |
| Expensive planner computations | Preserve the existing per-user advice limit; add a durable guest-global hourly cap before public rollout, initially 300/hour. |

At the current defaults, Sprout reserves
`context_chars * model_calls + max_output_tokens + 1600`: 17,100 for a one-call
intent and 31,100 for routed/retry turns. A suggested 10,000-token guest limit
would therefore block every turn. Validate guest budgets against the maximum
reservation whenever configuration changes. Known actual usage is settled later;
unknown usage conservatively retains the reservation. Advertise limits as "up to"
and show an actionable quota message, never "six guaranteed answers."

The current app-global defaults are 100 requests and 180,000 tokens/day; actual
deployment settings may differ. Guest caps must never raise or bypass those
settings. Separate guest-pool limits reserve headroom for registered users, but
provider availability still is not guaranteed. Confirm these budgets with the
project owner before enabling public creation.

Measure worst-case storage per guest, including satellite series and chat evidence,
against the actual database plan before choosing the retained-identity ceiling.
The proposed 1,000 is a ceiling, not a claim that the database can afford that many
fully populated guests. Lower it based on the measurement and maintain headroom
for registered users and shared environmental caches. Enforce record-count limits
transactionally so concurrent saves cannot bypass them.

### 8.2 Durable accounting

- Add a small SQL-backed rate-counter table with a composite unique key such as
  `(action, scope_key, window_start)`, plus count and expiry. Use atomic bounded
  increment/upsert operations, not read-then-write counters. Implement equivalent
  SQLite and PostgreSQL behavior and concurrency tests.
- Counters for network/global limits have no `users` cascade dependency. Keep them
  for at most 48 hours after their window closes; prune them in the cleanup job.
  Per-user content deletion must not grant fresh global/network capacity.
- Protect the global retained-guest ceiling transactionally; a bare concurrent
  `COUNT` check is insufficient. A stable global admission lock/counter row can
  serialize the short admission transaction before counting and inserting.
- Reuse `chat_usage_daily` for user and global budgets; add a `guest:global` scope.
  Reserve all applicable scopes atomically in a consistent order, rolling back
  every reservation if any quota check fails.
- Record whether each `ChatRun` charged the guest budget, for example with an
  immutable `guest_budget_charged` boolean. Finish/failed/cancel paths must settle
  the same scopes and original UTC day, even after the user converts.
- If cleanup deletes a run while the provider is working, stop generation where
  possible and retain its conservative aggregate reservation. Do not refund work
  with unknown usage or recreate deleted user accounting rows.
- Existing UUID-based user usage survives conversion; only future limits change
  to registered limits. Switching accounts or clearing cookies must not erase
  global/network counters. Registered-account farming is a broader abuse risk,
  not something guest limits alone can solve.
- If durable quota storage is unavailable, fail closed for new guest creation and
  expensive operations with a retryable service error. Do not fall back to an
  unlimited in-memory allowance.

### 8.3 Proxy trust and privacy

The current `client_ip` uses `request.client.host`; establish what it represents
through the deployed proxy chain before enforcing network quotas. Do not blindly
trust arbitrary `X-Forwarded-For` or configure every remote address as a trusted
proxy. Verify the hosting platform's authoritative client-IP contract, including
direct access to the Render origin. If trustworthy attribution is unavailable,
retain global caps and keep public creation gated until a trusted edge rule or
server-verified challenge is in place.

Use a server-secret HMAC of a normalized, documented network identifier for short
abuse windows; do not store raw IPs, cookies, credentials, or device fingerprints
in counters. These identifiers remain pseudonymous data, not anonymous data.
Document retention and secret rotation; avoid rotating in a way that silently
resets active quota windows. School/corporate/carrier networks may share an IP,
so test false positives and provide a clear retry/account-creation alternative.
IP controls alone cannot reliably distinguish a person or stop a distributed bot.

## 9. Frontend and user experience

### 9.1 Entry and ongoing use

- Add the secondary **Continue as guest** command to the login/register shell,
  styled consistently in light and dark themes. Show it only when the server
  advertises guest creation. Do not change the default sign-in route.
- Before submission, disclose inactivity expiry, same-browser access, limited
  resources, and that creating an account keeps the data. Use the actual server
  policy values. A failed capabilities request must not imply guest availability.
- Disable duplicate submissions; show busy, rate-limited, unavailable, and
  connection-failure states. After an ambiguous timeout, check `/auth/me` before
  offering a new creation attempt.
- On success, use the normal farms dashboard with an empty list, not a shared
  demo farm or forced environmental downloads. Preserve a safe internal return
  route; a private farm belonging to another user remains inaccessible.
- Show a compact guest indicator, expiry date, and **Create account to keep your
  data** action in the signed-in layout. Do not cover farm controls or Sprout.
- The warning becomes stronger near expiry, but remains nonmodal and keyboard
  accessible. Refresh it from server metadata after meaningful activity.

Suggested entry copy: "Try CropCompass without signing up. Guest data expires
after 30 days of inactivity. Clearing cookies or ending this session can remove
your access. Create an account to keep your data. Usage limits apply."

### 9.2 Account conversion and ending a session

- Put the conversion form in the existing account screen for guests. Reuse the
  name/email/password inputs, validation, password visibility, and translations.
  Add confirmation matching the existing account password UX where appropriate.
- Explain that all current farms, journal entries, saved plans, and Sprout chats
  will remain attached. Submit to conversion, never public `/auth/register`.
- A duplicate-email response keeps the guest logged in and their form usable.
  Offer a different email or an explicit sign-in path with a no-merge warning.
- On success, update `/auth/me`, remove guest-only UI, preserve selected farm and
  language/theme, and show a success status. Do not wipe records or generate new IDs.
- Conversion rotates all sessions. Offer to stop an active Sprout response before
  submitting, preserve completed history, and handle another tab's old session
  gracefully. Do not restart a billable model call automatically.
- Replace password-change controls for guests with conversion. Keep language,
  export, and a distinct **Delete guest data** action. Require explicit destructive
  confirmation and distinguish deletion from ending a session.
- Confirm before **End guest session** or existing-account sign-in: the remaining
  data is not automatically transferred, and the guest cannot recover it without
  the session. Offer conversion, export, cancel, or confirmed session termination.
- If a session is lost or expires, return to a signed-out state with an honest
  message. Do not claim that retained rows are already physically deleted.

### 9.3 Cache, localization, and accessibility

[Query hooks](../frontend/src/api/hooks.ts) currently use shared keys such as
`["me"]` and `["farms"]`, and login/register only replace `me`. Clear/cancel all
identity-scoped queries and in-flight work when the UUID changes, on deletion,
logout, or confirmed session expiry. Unmount private screens and clear Sprout
preferences/drafts before showing another identity's data. Do not clear the same
UUID's saved farm data merely because it converted.

Synchronize identity changes across tabs using an event containing no credentials
(for example, BroadcastChannel) and re-fetch `/auth/me` on focus. A stale response
from an old identity must not repopulate the new identity's cache. Cancel streams
on identity change. Do not store session tokens, passwords, or full farm data in
localStorage. Existing user-scoped Sprout consent should stay scoped to the UUID.

Add English, Hindi, and Telugu keys and keep interpolation placeholders aligned.
Check mobile widths 320/390 px, desktop 1365 px, both themes, keyboard focus,
screen-reader status announcements, long translations, and reduced motion. Show
expiry dates in the user's locale, but store and compare timestamps in UTC.

## 10. Cleanup hosting and operations

Recommended host: a separate **Render Cron Job** running the backend cleanup CLI,
not an in-process timer inside Uvicorn and not a browser-triggered deletion route.
An API process can sleep or restart; request-time opportunistic cleanup is not a
reliable retention scheduler. Keep access expiry enforcement independent of cron.

Proposed deployment configuration after the command exists:

| Setting | Proposal |
| --- | --- |
| Source/root | Same reviewed release as the API; working directory `backend`. |
| Build | Install the existing backend package and dependencies. |
| Schedule | `0 3 * * *`, daily at 03:00 UTC. |
| Command | `python -m app.guest_cleanup --execute --batch-size 100 --max-batches 20`. |
| Connection | Correct deployment's `DATABASE_URL`, TLS required. Transaction-scoped row locks work with pooling; no session-scoped advisory locks. |
| Secrets | Server-side environment only, minimum necessary database/policy settings. No model or mail credentials needed by cleanup. |
| Initial rehearsal | Dry-run using the same release/settings; inspect counts, then enable execution after approval. |

Render documents UTC schedules, per-job single-run behavior, and cancellation of
an active run when another is manually triggered. Keep database operations retry-
safe anyway because another scheduler/manual command may exist. Make the command
exit, enforce a runtime budget, handle termination without partial transactions,
and report remaining backlog rather than declaring success after hitting a cap.
Do not silently depend on host retries: alert and provide a manual rerun procedure.

This adds scheduler cost. Render's documented minimum at review time is $1/month
per cron service plus applicable compute billing; verify current pricing and get
approval. If that service is unavailable, an approved external scheduler can run
the same CLI with protected credentials. Do not expose an unauthenticated cleanup
HTTP endpoint as a substitute.

Required observability and runbook:

- Emit structured counts for scanned, deleted, skipped, failed, and remaining
  expired guests, plus runtime and oldest-expired age. Never log emails, farm
  content, IPs, session tokens, passwords, or database URLs.
- Use scheduler history/monitoring for last successful completion. Alert on any
  failed run, no success for 26 hours, or an expired-data backlog older than
  24 hours. An independent alert must detect a job that never starts.
- Track new/active/converted/expired guest counts, creation denials, quota denials,
  model usage by guest/registered pool, database growth, and refresh volume.
- Operator recovery: verify target environment and migration, inspect a dry-run,
  rerun bounded cleanup, then confirm backlog and registered-user preservation.
  Increase batch/runtime limits only after reviewing load; never delete all users.
- Backups restored for an incident must not silently restore expired access.
  Run expiry reconciliation before reopening traffic. User-requested deletions
  restored from backup need a restricted deletion-audit/tombstone policy covering
  the actual backup window; approve that privacy policy before launch.

## 11. Configuration and migrations

Proposed new settings, all server-side:

| Setting | Recommended initial value/purpose |
| --- | --- |
| `GUEST_ENABLED` | `false` until rollout gates pass; controls new creation only. |
| `GUEST_RETENTION_DAYS` | `30`. |
| `GUEST_WARNING_DAYS` | `7`; must be positive and no longer than retention. |
| `GUEST_ACTIVITY_INTERVAL_SECONDS` | `900`; coalescing for activity writes. |
| `GUEST_MAX_FARMS` | `3`. |
| `GUEST_MAX_SEASONS_PER_FARM`, `GUEST_MAX_PLANS_PER_FARM` | `200`, `50`. |
| `GUEST_CREATIONS_PER_IP_HOUR`, `GUEST_CREATIONS_PER_IP_DAY` | `5`, `20`; apply only after trusted proxy attribution is verified. |
| `GUEST_CREATIONS_GLOBAL_DAY`, `GUEST_MAX_IDENTITIES` | `100`, `1000`. |
| `GUEST_DATA_BUILDS_HOUR`, `GUEST_DATA_BUILDS_DAY`, `GUEST_DATA_BUILDS_GLOBAL_DAY` | `2`, `6`, `50`. |
| `GUEST_ADVICE_GLOBAL_HOUR` | `300`, in addition to existing per-user limits. |
| `GUEST_SPROUT_DAILY_REQUESTS`, `GUEST_SPROUT_DAILY_TOKENS` | `6`, `40000`. |
| `GUEST_SPROUT_GLOBAL_DAILY_REQUESTS`, `GUEST_SPROUT_GLOBAL_DAILY_TOKENS` | `30`, `80000`, bounded by overall Sprout caps. |
| `GUEST_SPROUT_IP_DAILY_REQUESTS` | `20`. |
| `GUEST_ABUSE_HMAC_KEY` | Required secret before public enablement; never in frontend env or examples with a real value. |

Keep cleanup batch/runtime settings as CLI options. Turning off new guest creation
must not block existing guests from export, conversion, or deletion, and must not
stop retention cleanup. Existing `SPROUT_ENABLED` remains the global generation
control; a guest-only generation kill switch may be added if operations needs it.

The source migration head is currently
[0006](../backend/migrations/versions/0006_sprout_chat.py). Use the next available
Alembic revision, provisionally `0007_guest_access`; recheck the head when work
starts rather than assuming no parallel migrations were added.

Migration sequence:

1. Rehearse on isolated SQLite and an approved disposable PostgreSQL branch with
   synthetic registered/guest fixtures, not the configured live application DB.
2. Add identity fields, relax credential nullability, and backfill existing users
   as registered with `registered_at = created_at`. Preserve UUIDs, names, email
   values, password hashes, sessions, and all owned data.
3. Add constraints/indexes, durable abuse-counter storage, and the chat-run budget
   provenance field. Existing runs did not charge a guest pool; backfill false.
4. Verify SQLite table rebuilding preserves cascading foreign keys/indexes and
   `PRAGMA foreign_keys` remains enabled. Verify real PostgreSQL locking semantics.
5. Test upgrade, repeat upgrade, and a safe downgrade on an empty/synthetic guest
   set. Downgrade must refuse while guest/null-credential rows exist; it must not
   invent credentials, silently delete guests, or lose live budget accounting.
6. Apply reviewed production migrations only after explicit approval and backup/
   restore planning. Use `DATABASE_URL_UNPOOLED` for migrations, as the repo already
   supports, and pooled `DATABASE_URL` for request traffic.

Plan for old API workers during the migration/deploy interval. `is_guest` needs
a database-side false default, not just an ORM default. If the final registered
state requires `registered_at`, provide a database timestamp default for legacy
registered inserts; guest creation must explicitly insert SQL NULL for that field
rather than allowing the ORM to omit it and trigger the default. Test old-style
registration inserts against the migrated schema. Alternatively split expansion
and final constraints into separate reviewed migrations, drain old workers, and
backfill again before enforcing the final constraint. Do not enable guest creation
until all serving API workers understand nullable credentials and expiry.

If retention settings change later, do not silently shorten persisted deadlines.
Use an explicit policy migration/notice. The stored expiry remains authoritative;
future extensions must honor any promised later deadline until the policy change
is approved. Config validation should reject invalid intervals and unusable model
budgets before enabling creation.

## 12. Implementation map and work sequence

Prefer changes in existing owners; add only the few new service/CLI/test modules
that isolate guest lifecycle and cleanup behavior.

| Existing file or area | Planned work |
| --- | --- |
| [models.py](../backend/app/models.py), [schemas.py](../backend/app/schemas.py), [migrations](../backend/migrations) | Identity states, response types, constraints/indexes, rate counters, budget provenance, migration. |
| [config.py](../backend/app/config.py), [environment example](../backend/.env.example) | Validated defaults, feature gates, secret placeholders; do not modify real env files automatically. |
| [auth.py](../backend/app/routers/auth.py), [security.py](../backend/app/security.py), [deps.py](../backend/app/deps.py) | Session helper transaction boundary, guest bootstrap/activity, shared expiry guard, nullable-credential protection. |
| [account.py](../backend/app/routers/account.py) | In-place conversion, guest-specific deletion, export metadata, registered-only password operations. |
| [main.py](../backend/app/main.py), [ratelimit.py](../backend/app/ratelimit.py) | Capabilities/route wiring, strict guest-bootstrap Origin handling, durable guest admission controls alongside existing burst limits. |
| [farm router](../backend/app/routers/farms.py), [planner router](../backend/app/routers/planner.py), [vegetation router](../backend/app/routers/vegetation.py) | Guest capacity/build/advice caps and short race-safe ownership checks. |
| [season router](../backend/app/routers/seasons.py), [planner router](../backend/app/routers/planner.py) | Guest journal/plan count limits without blocking reads, edits, exports, or deletion at capacity. |
| [Sprout service](../backend/app/services/sprout.py), [chat router](../backend/app/routers/chat.py) | Guest/global reservation and settlement, expiry-aware live runs, no quota reset on conversion/deletion. |
| [farm data service](../backend/app/services/farm_data.py), [vegetation service](../backend/app/services/vegetation.py) | Verify missing-owner behavior during deletion and stop private writes. |
| [API hooks](../frontend/src/api/hooks.ts), [types](../frontend/src/api/types.ts), [client](../frontend/src/api/client.ts) | Guest types/mutations, activity checkpoint, error translation, identity-cache cleanup and request cancellation. |
| [AuthPage](../frontend/src/pages/AuthPage.tsx), [AccountPage](../frontend/src/pages/AccountPage.tsx), [Layout](../frontend/src/components/Layout.tsx) | Entry disclosure, guest status, conversion, export/delete/end-session UI and protected-route behavior. |
| [Sprout launcher](../frontend/src/features/sprout/Sprout.tsx), [panel](../frontend/src/features/sprout/SproutPanel.tsx) | Appropriate limits/expiry messaging, preserve UUID-scoped history, close/cancel on identity changes. |
| [locales](../frontend/src/locales), [knowledge](../backend/app/knowledge/sprout.json), [SPROUT.md](SPROUT.md) | Three-language guest copy and accurate assistant/platform documentation after feature implementation. |

Proposed new modules: `backend/app/services/guests.py` for lifecycle/transactions,
`backend/app/guest_cleanup.py` for CLI orchestration, and one focused
`backend/tests/test_guests.py` for lifecycle/cleanup cases. Reuse the existing
database/test fixtures; do not create a second auth framework or test application.
The durable counter helper may live with rate limiting rather than introducing a
separate storage service. New filenames are proposals, not existing artifacts.

Recommended order with exit gates:

1. **Approve policy and budgets:** agree retention, caps, scheduling cost, proxy
   trust, backup/deletion retention, and the no-merge first release.
2. **Schema and backend lifecycle:** migrations, shared expiry guard, transactional
   session helper, guest creation/activity, conversion, deletion/export. Exit when
   identity preservation, rollback, and ownership tests pass.
3. **Durable limits and cleanup:** quota storage, guest pool accounting, worker
   cancellation, cleanup CLI, concurrent renewal/conversion tests. Exit when
   PostgreSQL race tests and dry-run/retry tests pass.
4. **Frontend integration:** entry, status, account conversion, loss/expiry states,
   translations, cross-tab/cache behavior, and theme/responsive checks.
5. **Staging acceptance:** deploy matching API/frontend/cron versions, validate real
   proxy cookies/IP attribution, run scheduled synthetic expiry and a controlled
   Sprout test within an approved provider budget.
6. **Production rollout:** explicit migration/hosting approval, migrate with guest
   creation disabled, deploy coordinated code, verify scheduler/alerts, then enable
   creation. Monitor costs, failed conversions, and deletion lag closely.

The earlier 3-5 engineering-day estimate was preliminary. These inspections expose
durable admission limits, proxy validation, and concurrency work that a demo would
skip. Re-estimate after policy decisions and staging infrastructure are confirmed;
do not promise that the full release gates fit that estimate.

## 13. Verification and acceptance checklist

### 13.1 Automated backend tests

Reuse [auth tests](../backend/tests/test_auth_api.py),
[account tests](../backend/tests/test_account_api.py),
[Sprout tests](../backend/tests/test_sprout.py), and the existing farm/history/
planner fixtures. Add guest-specific coverage without changing real user data.

- [ ] Valid identity constraints; existing registered accounts unaffected by upgrade.
- [ ] Legacy registered inserts remain valid during rollout; guest inserts explicitly
  keep `registered_at` null; all workers are guest-aware before creation is enabled.
- [ ] First creation is atomic; cookie security flags and token hashing are correct.
- [ ] Repeated creation with a live guest resumes one UUID and preserves usage.
- [ ] Regular sessions cannot be downgraded; stale-cookie handling does not revive guests.
- [ ] Origin/CSRF failures on bootstrap, activity, conversion, and deletion.
- [ ] Guest A, Guest B, and registered C cannot read or change each other's farms,
  soil, journal, plans, threads, runs, exports, or deletion targets.
- [ ] Time-controlled tests immediately before, exactly at, and after expiry;
  renewal works before expiry and never revives an expired identity.
- [ ] Idle polling/background jobs do not renew; checkpoint throttling and cookie
  lifetimes agree, including dropped-response recovery and multiple tabs.
- [ ] Nullable credentials cannot crash login, reset, change-password, or deletion.
- [ ] Conversion preserves user/farm/record IDs and contents, rotates cookies,
  revokes old sessions, clears expiry, and permits subsequent password login.
- [ ] Duplicate/case-normalized email, simultaneous registration, failed hashing,
  commit failure, and duplicate conversion leave correct state with no data loss.
- [ ] Cleanup/activity/conversion/delete races and child-write/stream completion
  races are deterministic on real PostgreSQL, with no deadlocks or resurrection.
- [ ] Dry-run changes nothing; execute deletes all owned children; rerun is safe;
  a failure/termination can resume without changing already converted accounts.
- [ ] Shared climate caches, other users, and aggregate budget counters survive.
- [ ] Quotas hold across concurrent requests, API restart, separate workers,
  delete/recreate cycles, conversion, midnight boundaries, and absent quota storage.
- [ ] Every applicable Sprout scope reserves/settles once; too-small budgets are
  rejected; unknown-usage deletion retains conservative global charges.
- [ ] Export contains expected guest metadata and data but no hashes, credentials,
  provider keys, internal counters, or another identity's information.
- [ ] Retention/config changes, disabled creation, normal-account regression, and
  cleanup batch/runtime/backlog reporting behave as specified.

Extend the guarded [PostgreSQL integration test](../backend/tests/test_neon.py),
which currently expects revision `0006`, to the actual new migration head. Its
fixture refuses the application database and expects a disposable branch with
no shared weather rows. Use a dedicated schema-only/synthetic environment for that
fixture; do not weaken its guard to run against production or a populated clone.
Migration rehearsal on populated data is a separate, explicitly approved step.

### 13.2 Browser and hosted acceptance

- [ ] Guest entry -> create farm -> journal -> soil -> climate/vegetation -> crop fit
  -> next crop/rotations -> stress -> save/compare/export, using supported fixtures.
- [ ] Sprout consent, quota messaging, history/reload, retry/stop, and expiry during
  streaming, without bypassing model or application budgets.
- [ ] Convert a populated guest; all records remain after reload and later login;
  regular password change/reset/export/deletion still work.
- [ ] Existing-email conflict leaves guest data available; switching accounts does
  not show cached guest data or imply a merge.
- [ ] Browser restart, cleared cookies, logout, network interruption, stale tabs,
  expired session, and disabled guest creation each have honest UI states.
- [ ] End-session and delete-data confirmations are distinct; cancellation is safe.
- [ ] English/Hindi/Telugu, light/dark, 320/390 px mobile and 1365 px desktop,
  keyboard and screen-reader checks pass with no obstructed controls.
- [ ] Deployed cookies, CSRF, no-store responses, real proxy client identity,
  database connectivity, scheduler execution, and failure alerts are verified.

Commands below describe future verification, not work performed for this plan:

```powershell
# From backend/, using the project's environment and isolated fixtures:
.\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider tests/test_guests.py tests/test_auth_api.py tests/test_account_api.py tests/test_sprout.py
.\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider --ignore=tests/test_neon.py
.\.venv\Scripts\ruff.exe check .
.\.venv\Scripts\ruff.exe format --check .

# From the repository root:
npm --prefix frontend run build
npm --prefix frontend run check:locales
npm --prefix frontend run test:sprout
```

Run the opt-in PostgreSQL suite separately with `CROPCOMPASS_NEON_TEST_ENV`
pointing to the approved disposable environment. Use mocked providers for routine
tests; require an explicit budget for live Sprout acceptance. Check actual test
collection and counts, not merely an exit code from an empty test selection.

## 14. Rollback and operational safety

- First response to abuse/cost problems: disable new creation and, if necessary,
  guest model generation. Keep conversion, export, deletion, and cleanup working.
- Do not deploy the old backend after guest rows exist: it assumes non-null email
  and passwords and has no expiry guard. Roll back to a guest-aware release or
  use feature gates while fixing forward.
- Do not downgrade the schema or purge guests to make an older binary start.
  Resolve every guest's state explicitly before any approved destructive downgrade.
- A whole-database restore can undo unrelated user work and restore deleted data;
  it is not the normal rollback for this feature. Use an approved incident runbook.
- Preserve existing app ports, environment precedence, secrets, session names,
  deployed origins, and all registered data. Never commit actual credentials or
  copy production accounts into a public demo environment.

## 15. Decisions to approve before implementation

1. Confirm 30-day inactivity retention, 7-day warning, 15-minute activity checkpoint,
   daily cleanup, and the distinction between expiry and physical deletion.
2. Approve the resource limits in section 8 and visible "usage limits apply" copy.
3. Confirm conversion to a new email only; existing-account merging remains out of
   scope, and no new email verification is included in this release.
4. Approve scheduler ownership/cost, alert destination, and the person responsible
   for missed cleanups and quota incidents.
5. Verify the deployed proxy trust model or choose an approved anti-abuse edge/
   challenge mechanism before exposing public creation.
6. Agree backup/log/provider retention and restoration/deletion-audit obligations.
7. Approve isolated database testing, then separately authorize production migration
   and feature enablement after all acceptance gates pass.

## 16. References and planning validation

- [Existing project plan](PLAN.md) and [research/decisions](RESEARCH_AND_DECISIONS.md).
- [Sprout architecture and operational limits](SPROUT.md).
- [Render Cron Jobs](https://render.com/docs/cronjobs): scheduling, execution,
  environment, single-run behavior, and billing, checked 2026-11-07.
- [Neon branching](https://neon.com/docs/introduction/branching.md): isolated
  migration/test environments and backup-history considerations, checked 2026-11-07.
- [Neon connection pooling](https://neon.com/docs/connect/connection-pooling.md):
  pooled app traffic and direct migration connections, checked 2026-11-07.

See the implementation record at the top for completed local checks. Production
migration, PostgreSQL runtime/race verification, load testing, scheduler/alert
provisioning, and successful live-provider acceptance remain release gates.