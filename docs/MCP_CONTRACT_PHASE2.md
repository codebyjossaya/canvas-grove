# Canvas Grove MCP: phase 2 (quizzes, write access, auto mode)

Extends `docs/MCP_CONTRACT.md` (phase 1 is built: `lib/mcp/**`, `app/mcp`, `app/oauth`,
`app/.well-known`, 13 read tools, PATs, OAuth). Owner decisions (2026-11-13): the MCP server is
**not read-only**, gets **quiz tools**, has an **auto mode**, and quizzes are approval-gated **at
entry only**. Phase 1 policy lines "no quiz content" and "no write tools" are superseded here.

## Principle: models propose, people approve (unless the person turned on auto mode)

Every write that touches Canvas or anything outward-facing is **staged** by default: the tool returns
`{ actionId, status: "awaiting_approval", preview, expiresAt }` and nothing happens until the
signed-in user approves it **inside Grove**. There is no MCP tool that approves, enables auto mode,
or changes any setting; approval and auto-mode endpoints accept only a Clerk session with CSRF
(never a bearer token). Pending actions expire after 30 minutes. Executed immediately regardless of
mode (reversible, Grove-local): planner notes/to-dos and "mark done" inside Grove.

## Auto mode (per connection, user-enabled, time-boxed)

Auto mode lets a connection's staged actions execute **without waiting for approval**. It is a
setting on one connection (one PAT or one OAuth grant), never global, and:

* **Off by default.** Turned on only in Grove's UI (Clerk session + CSRF), never by a token.
* **Chosen categories**, none preselected: `submit_assignment`, `outward_messages` (discussion
  replies and messages), `quiz_entry` (starting a supported quiz attempt, see below).
* **Time-boxed:** 1 h (default), 8 h, 24 h, or until turned off. The expiry is enforced server-side on
  every call; an expired or revoked setting silently falls back to normal approval.
* **Caps:** at most 30 auto-executed actions per hour and 200 per day per connection, then it falls
  back to approval and notifies. A visible kill switch turns it off instantly and cancels anything
  still `awaiting_approval` for that connection.
* **Still recorded:** an auto-executed action is stored exactly like an approved one (status `done`,
  `decidedBy: "auto"`, full preview/payload snapshot and result) and appears in the Approvals history
  with an "Auto" badge. Revoking the connection ends auto mode.
* **What it never changes:** the quiz eligibility gate, argument validation, the "target still allows
  this action" re-check at execution, rate limits, and the policy that tokens cannot enable it.

## Scopes and consent

* `canvas:write` scope for any staged tool. Phase 1 tokens keep `canvas:read` only. OAuth consent lists
  it separately in plain words ("Propose actions for you, such as submitting an assignment. Nothing is
  sent until you approve it in Canvas Grove, unless you turn on auto mode for this connection.");
  read-only stays the default selection. PATs get an "Allow proposing actions" checkbox, off by default.
  Update the consent page text accordingly (it currently says it cannot submit work or see quiz questions).
* Revoking a token or grant also cancels its pending actions and ends its auto mode.

## Write tools (all `readOnlyHint: false`; staged unless noted or auto mode applies)

`submit_assignment` (online text entry or URL; file uploads only from files already in Grove),
`save_planner_note` and `complete_planner_item` (immediate, Grove-local), `reply_to_discussion` and
`send_message` (staged), `get_action` / `list_actions` / `cancel_action` (own actions only).
Staging validates with zod and snapshots exactly what will be sent. Execution is server-side with the
owner's Canvas session, re-checks the target still allows it (open, not locked, attempts left), is
idempotent per `actionId`, and writes the outcome back to the action row.

## Quizzes: all supported Classic Quiz modes, approval at ENTRY only

Wrap Grove's quiz service (`lib/quizzes/service.ts`) as: `get_quiz` (rules, attempts left, time limit,
type, points, `eligibleForAssistant`), `start_quiz_attempt` (**the only approval-gated quiz step**),
`get_quiz_question`, `answer_quiz_question`, `submit_quiz_attempt`, `get_quiz_result`.

* **Entry approval:** `start_quiz_attempt` is staged (category `quiz_entry`; auto mode may cover it).
  The approval preview says plainly which Canvas assessment type it is and whether it is graded:
  "Let <assistant> take this <type>: it can read the questions, answer them and submit this attempt."
  A graded assessment also carries an explicit grade-impact warning. Approving creates an **entry-scoped quiz session**
  bound to (connection, quiz, attempt) that lasts until the attempt ends or 2 h, whichever is first.
* **Whole quiz in one call (the default):** `get_quiz_question` without `questionId` returns every
  question drawn for the attempt (question-group picks included, with `groupId`): type, points,
  text with LaTeX math and `[blank N]`/`[dropdown N: …]` markers, options, `blanks`, `matches`,
  saved answers and `timing`. Nothing is dropped: a question Grove cannot save (multiple dropdowns,
  matching, fill-in blanks whose ids Canvas hides, embedded media) comes back with
  `answerable: false` and a `note`, and the result carries a top-level `note` with the count. Large
  attempts are bounded (about 40k chars) with `truncated`, `total`, `offset` and `nextCursor`. It is
  read-only (GET only; `lib/mcp/quiz-read.ts`): one session lookup and cookie-jar client per call,
  the attempt state once, then question pages and timer in parallel. Pass `questionId` to re-read one.
* **Whole-quiz answering:** `answer_quiz_questions` takes `answers: [{ questionId, answer }]` (up to
  200) for the approved attempt, under the same entry-session gate as `answer_quiz_question` (no extra
  approval, no submission). Every entry is validated against the attempt first
  (`lib/mcp/quiz-bulk.ts`); results are per question: `saved`, `rejected` (code + reason),
  `unsupported_type`, `not_in_attempt`, `duplicate`, `failed`, or `skipped` (after a fatal error such
  as expired sign-in or a changed attempt). Saves run one at a time through the quiz service's
  `saveAnswer` (its time/lock/attempt checks apply). `submit_quiz_attempt` stays a separate call.
* **Inside a session no further approval is needed**: `get_quiz_question`, `answer_quiz_question`,
  `answer_quiz_questions` and
  `submit_quiz_attempt` run immediately, but only for that exact attempt; any other quiz or attempt
  needs its own entry approval. Cancelling or revoking the connection ends the session.
* **Technical eligibility gate (enforced server-side on every call, fail closed, never cached):** all
  four Canvas Classic Quiz types are supported: `practice_quiz`, `assignment` (graded quiz), `survey`
  (ungraded), and `graded_survey`. Grading is derived from `quiz_type`, never guessed from points.
  Proctored or locked-down quizzes (Honorlock, lockdown browser, access code, IP filter), New Quizzes,
  unknown types/restrictions, and content Grove's native quiz mode cannot reproduce return
  `{ code: "QUIZ_NOT_ELIGIBLE", reason }` with no question text, even in auto mode and even if a
  session exists. Blocked attempts are audit-logged. `list_quizzes` stays metadata-only and reports
  `assessmentKind`, `practice`, `graded`, and `eligibleForAssistant`.

## Data model (migration `drizzle/0013_mcp_actions.sql`, owner-scoped forced RLS like 0012)

* `mcp_pending_actions` (id, owner_id, token_id/grant_id, client_name, tool, category, args jsonb, preview
  jsonb, status `awaiting_approval|approved|rejected|executing|done|failed|expired|cancelled`, decided_by
  `you|auto|system`, created_at, expires_at, decided_at, result jsonb, idempotency_key).
* `mcp_auto_modes` (id, owner_id, token_id/grant_id unique, enabled, categories text[], expires_at,
  created_at, updated_at, counters for hourly/daily caps).
* `mcp_quiz_sessions` (id, owner_id, token_id/grant_id, quiz id, attempt id, expires_at, ended_at).
* `mcp_audit` (owner_id, at, token_id, client_name, tool, outcome, action_id, decided_by; never content).
Cap 20 awaiting actions per owner; write rate limit per token per hour.

## Web API for the Grove UI (Clerk + same-origin + `x-grove-csrf: 1`, `Cache-Control: no-store`)

```
GET  /api/canvas/mcp/actions?view=awaiting|history&limit=50
  -> { awaitingCount: number,
       actions: [{ id, tool, category, title, summary, preview: { lines: [{ label, value }], warning?: string },
                   client: { name, connectionId, kind: "token"|"grant" }, status, decidedBy: "you"|"auto"|"system"|null,
                   createdAt, expiresAt, decidedAt|null, result?: { ok: boolean, message: string } }] }
POST /api/canvas/mcp/actions/:id/approve  -> { action }   (executes now; 409 if no longer awaiting; 410 if expired)
POST /api/canvas/mcp/actions/:id/reject   -> { action }
GET  /api/canvas/mcp/auto-mode
  -> { targets: [{ kind: "token"|"grant", id, name, canPropose: boolean,
                   auto: { enabled: boolean, categories: string[], expiresAt|null, usedLastHour: number, usedToday: number } }] }
PUT  /api/canvas/mcp/auto-mode/:kind/:id
  { enabled: boolean, categories: ("submit_assignment"|"outward_messages"|"quiz_entry")[],
    durationMinutes: 60|480|1440|null }          // null = until turned off
  -> { target }   (enabling requires at least one category; 409 if the connection cannot propose actions)
```
Errors `{ error, code }` with matching status. Categories and defaults are exported from
`lib/mcp/categories.ts` so UI and backend share them.

## File ownership

* Backend (phase 2): `lib/mcp/**` (extend; do not rewrite phase 1 behaviour), `app/mcp/**`,
  `app/oauth/**` (consent text/scope only), `app/api/canvas/mcp/**` (add the endpoints above),
  `drizzle/0013_*` and the journal, `tests/mcp-*`. Imports `lib/quizzes/**` and `lib/canvas/**` read-only.
* UI: `app/(workspace)/approvals/**`, `components/workspace/approvals/**`, `app/ui-preview/approvals/**`,
  `tests/approvals*`, and extends (additively) `components/workspace/connect-agent/connections-list.tsx`
  and its CSS with the per-connection auto-mode controls and `canPropose` indicator; no edits to
  `app-shell.tsx`, layouts or other shared chrome (the integrator adds the badge later).
* Nobody edits: `extension/**`, `lib/extension/**`, `docs/MCP_CONTRACT.md` (phase 1), the motion files
  (`app/motion.css`, `components/ui/shell-effects.tsx`, `theme-provider.tsx`) which another agent owns.

## Verification rules

Live tests run as the dev owner only. Never execute a real assignment submission or message: test those
through staging plus a stubbed executor. Quizzes: exercise the real path only against a deliberately
selected developer-owned fixture; otherwise stub it. Unit coverage must include practice quizzes,
graded quizzes, ungraded surveys and graded surveys, and must prove proctored and New-Quiz fixtures are
refused with no question text leaked, in every mode including auto.
Prove: tokens cannot approve or enable auto mode; auto mode expiry/caps/kill switch/revocation behave;
a quiz session cannot be used for a different attempt; approval executes exactly once (idempotent).
