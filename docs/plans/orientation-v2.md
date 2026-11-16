# Orientation v2: extension-gated Canvas sign-in, scopes, agent

Branch `feat/orientation-v2` (off `codex/extension-auth` @ 989b150), worktree `~/projects/canvas/worktrees/extension-auth` on jc-homelab.
The stack runs in **prod mode**: nothing you edit is live until the lead rebuilds. Do not build, deploy, restart containers, or commit. The lead does that once after all work lands.

## Goals (user requirements, verbatim intent)
1. Orientation **requires** the Grove extension to be installed (and paired). Unskippable. Detection must be polished (instant, no "Check again" guesswork).
2. Orientation **requires** Canvas sign-in through the extension. It is a step inside orientation, not a hop to Settings.
3. From orientation, Grove tells the extension to open a **new tab** (not a popup window) for the Canvas sign-in.
4. That tab shows a **Chrome side panel** that tells the user to finish signing in.
5. The extension detects a completed sign-in by **watching network requests**, then **closes the tab immediately**.
6. Grove detects the completed sign-in, the cookies land in the DB (existing `/api/extension/canvas-auth`), and the user can continue.
7. A **scope allowance** step: (a) which Canvas data areas Grove may sync/read, enforced server-side; (b) what connected agents may do by default.
8. A **connect your agent** step. **Skippable** ("Set up later"), with live "connected" detection.
9. The UI must look crafted, not vibe-coded. See the design brief at the end. It is a hard requirement, not a nice-to-have.

## Orientation flow (new)
| # | Step | Gate to continue |
|---|------|------------------|
| 1 | Welcome | none |
| 2 | Your school | school selected |
| 3 | Install extension | extension detected **and** paired to this account (pairing happens inline on this step: name prefilled, one button) |
| 4 | Allow data | scopes saved (`PUT /api/settings/scopes`) |
| 5 | Sign in to Canvas | Canvas session for this owner is `connected` (server-verified) |
| 6 | Connect your agent | skippable; auto-detects a new MCP connection |
| 7 | Done | finish → `POST /api/onboarding` (server re-checks gates) → `/` |

Rationale for scopes before sign-in: the user agrees to what Grove will read before any Canvas session exists. Agent permission defaults are chosen on step 4 and applied in step 6.

- No "Skip for now" anywhere. Back always works and never destroys state.
- Resume: on load the wizard derives the furthest valid step from **real state** (extension hello, `/api/extension/status`-equivalent via web, Canvas sessions, saved scopes, MCP connections), not just saved flags.
- Users whose Canvas is already connected (replay, or existing users after the version bump) see steps 3-5 already satisfied, each with a compact "done" state and Continue enabled.
- `ORIENTATION_VERSION` becomes `2026-11-v2`, so every existing user goes through v2 once.
- Settings stays as the place to reconnect/revoke later. It uses the same sign-in hook (below).

## Contract 1: web ↔ extension protocol v2 (owners: A implements the extension side, B the web side)
Transport stays `window.postMessage` between the page and an extension content script, `source: "grove-web"` / `source: "grove-extension"`, same-origin checks as today. Every request carries `requestId`; every reply is `{source:"grove-extension", type:"reply", requestId, result}`.

The content script runs on **all Grove pages** (merge `bridge.js` into it). On load and whenever extension state changes it posts an unsolicited `{type:"state", state}`.

`state` / `hello` result shape:
```ts
type ExtState = { installed: true; protocol: 2; version: string; paired: boolean; deviceName: string | null;
  canvasOrigin: string | null; hasCanvasAccess: boolean; signin: SigninStatus | null };
```
Requests (page → extension):
- `hello` → `ExtState`.
- `pair {token, deviceName, canvasOrigin?}` → `{ok}`. Allowed only from paths `/welcome` and `/extension/connect`.
- `signin-start {sessionId, canvasOrigin, loginUrl, schoolName}` → `{ok, reason?}`. Opens a **new tab next to the Grove tab, focused**, at the extension page `signin.html?s=<sessionId>` (see flow below). Replaces any previous pending sign-in (closes its tab).
- `signin-status {sessionId}` → `SigninStatus | null`.
- `signin-focus {sessionId}` → focuses the sign-in tab, reopening it if the user closed it.
- `signin-cancel {sessionId}` → closes the tab and clears pending state.
- `open {url, force}` → unchanged link-open behaviour.

Unsolicited events (extension → all Grove tabs): `{type:"signin", status: SigninStatus}` on every stage change.
```ts
type SigninStage = "opening" | "needs-access" | "signing-in" | "verifying" | "captured" | "failed" | "cancelled" | "tab-closed";
type SigninStatus = { sessionId: string; stage: SigninStage; canvasOrigin: string; account?: { id: string; name: string };
  reason?: string; at: number };
```
`reason` codes are stable machine strings (e.g. `permission-denied`, `capture-rejected:<server code>`, `expired`, `revoked`, `session-cookie-missing`). The web maps them to copy.

Install detection: content scripts are not injected into tabs that were open before install. The background worker must, on `runtime.onInstalled` and `onStartup`, inject the content script into open Grove tabs with `chrome.scripting.executeScript`, so the orientation page flips to "detected" within ~1 s of "Load unpacked" with no reload. The web also re-sends `hello` on `visibilitychange`/focus and every 1.5 s while on step 3.

## Sign-in tab flow (owner A)
1. `signin-start` → `chrome.tabs.create({ url: signin.html?s=…, index: groveTab.index + 1, openerTabId })`. Stage `opening`.
2. `signin.html` is an extension page (Grove-themed interstitial): school name, the exact Canvas host, one line on what will be read (only cookies for this host), and **one primary button: "Continue to <School> Canvas"**. Its click handler is the user gesture that does:
   `chrome.permissions.request({origins:[origin/*]})` if missing (stage `needs-access` until granted; denied → `failed/permission-denied` with retry in place) → `chrome.sidePanel.setOptions({tabId, path:"sidepanel.html?s=…", enabled:true})` + `chrome.sidePanel.open({tabId})` → navigate the same tab to `loginUrl`. Stage `signing-in`.
   (The gesture is needed because both `permissions.request` and `sidePanel.open` require one; a message from a web page does not carry one. Do not try to skip this click.)
3. Side panel (`sidepanel.html`, tab-scoped, disabled for every other tab): live status for this attempt: "Sign in to <School> Canvas in this tab", what happens next ("This tab closes by itself once Canvas signs you in"), MFA note, the account once detected, and "Cancel sign-in". Same visual system as the popup.
4. Detection (background): while a sign-in is pending, `chrome.webRequest.onCompleted` / `onHeadersReceived` (with `extraHeaders` if needed to see `Set-Cookie`) filtered to `urls:[origin/*]` and `tabId` of the sign-in tab. Candidate signals: a `main_frame` 200 on the Canvas origin whose path is not `/login*`, `/saml*`, `/logout*`, `/login/*`; any 200 to `/api/v1/*`; a `Set-Cookie` of a session cookie name (`canvas_session`, `_normandy_session`, `_legacy_normandy_session`, `log_session_id`). On a candidate, run the existing `browserIdentity()` probe (strip `while(1);`). Also keep a 2 s fallback poll and `tabs.onUpdated` URL watch in case webRequest events are missed after a service-worker restart.
5. On a confirmed identity: stage `verifying` → read cookies (`chrome.cookies.getAll`) → **close the tab immediately** (cookies survive the tab) → POST `/api/extension/canvas-auth {sessionId, canvasOrigin, cookies}` → `captured` (with account) or `failed/capture-rejected:<code>`.
6. If the user closes the tab before success: stage `tab-closed`; `signin-focus` reopens at `loginUrl` (permission is already granted, so no interstitial).
7. Pending state lives in `chrome.storage.session` (survives SW restarts, not browser restarts). TTL 30 min → `failed/expired`.
8. Keep: no `*.instructure.com` host permission in the manifest (test asserts it); access is per exact origin via `optional_host_permissions`.
9. Manifest adds `sidePanel`, `webRequest`, `scripting`, `tabs` (only if needed for `openerTabId`/index; justify in a comment in the PR notes if added). Version **0.4.0**. Remove `windows.create` popup code.

## Contract 2: web sign-in hook (owner B; consumed by D and Settings)
`lib/extension/web-bridge.ts` (client-only): `extHello(timeoutMs?)`, `extRequest(type, payload, timeoutMs)`, `subscribeExtension(listener: (event: {type:"state", state: ExtState} | {type:"signin", status: SigninStatus}) => void): () => void`, the types above, `reasonMessage(reason): string`.

`lib/extension/use-extension.ts`:
```ts
useExtension(): { status: "checking" | "missing" | "outdated" | "unpaired" | "ready"; state: ExtState | null;
  pair(deviceName: string): Promise<void>;  // POST /api/canvas/extension/devices, then `pair` message; throws UiError-compatible
  recheck(): void }
```
`outdated` = protocol < 2. `EXTENSION_MIN_VERSION = "0.4.0"` lives in `lib/extension/links.ts` (owner A sets it).

`lib/extension/use-canvas-signin.ts`:
```ts
useCanvasSignIn(opts: { school: { name: string; domain: string } | null }): {
  phase: "idle" | "starting" | "awaiting-tab-click" | "signing-in" | "verifying" | "connected" | "error";
  account: { name: string } | null; session: { id: string; canvasOrigin: string } | null; error: UiError | null;
  existing: { connected: boolean; canvasOrigin: string; accountName?: string } | null; // already-connected session
  start(): Promise<void>;   // creates the hosted session + auth attempt exactly as canvas-session.tsx does today, then signin-start
  focusTab(): void; cancel(): Promise<void>; retry(): Promise<void> }
```
Completion is decided by **the server**: on `captured` (or every 2 s while `signing-in`/`verifying`, plus on focus) it reads `GET /api/canvas/sessions/:id` and only reports `connected` when the server says so. Extension events make it fast; server polling makes it correct if a message is lost.

## Contract 3: scopes (owner C; UI consumed by D)
Pure module `lib/scopes/catalog.ts` (no server imports):
```ts
export const DATA_SCOPES = ["courses", "assignments", "grades", "announcements", "inbox", "quizzes", "content"] as const;
export type DataScope = typeof DATA_SCOPES[number];
export const DATA_SCOPE_INFO: Record<DataScope, { label: string; description: string; required?: true; syncKinds: SyncKind[] }>;
// courses (required: courses, favorites), assignments (assignments, planner), grades, announcements, inbox, quizzes, content (course_content: pages, modules, files)
export type AgentAccess = "read" | "propose";
export type ScopeSettings = { data: DataScope[]; agent: { access: AgentAccess; autoCategories: AutoCategory[] }; savedAt: string | null };
export const DEFAULT_SCOPES: ScopeSettings; // all data on; agent "propose", no auto categories; savedAt null
```
API: `GET /api/settings/scopes` → `ScopeSettings`; `PUT` same body (validated; `courses` forced on). Same-origin + CSRF conventions as the other web routes (`requireWebUser`).
Storage: columns on `user_preferences` (`data_scopes text[]`, `agent_defaults jsonb`, `scopes_saved_at timestamptz`) via a new drizzle migration (`0007_*`), RLS unchanged (same table).
Enforcement:
- Sync worker skips sync kinds whose scope is off (and cancels queued jobs of that kind). Turning a scope off does not delete existing rows in this change; Settings copy must say so. Rows are hidden from UI/MCP reads (below).
- MCP read tools touching a disabled area return a clear tool error `SCOPE_DISABLED` naming the scope and where to turn it on.
- New OAuth grants and PATs default to `agent.access` (read → `canvas:read` only; propose → also `canvas:write`). `agent.autoCategories` is the default auto-mode set offered for a new connection; still never auto-enabled without the existing explicit toggle.
- Settings gets a "Data & permissions" section (`components/workspace/scopes-settings.tsx`) to change these later.

## Contract 4: onboarding server (owner C)
- `ORIENTATION_VERSION = "2026-11-v2"`.
- `GET /api/onboarding` → `{ completed, gates: { extensionPaired: boolean, scopesSaved: boolean, canvasConnected: boolean, agentConnected: boolean } }`. `extensionPaired` = at least one non-revoked `extension_devices` row for the owner.
- `POST /api/onboarding {completed:true}` → 409 `ORIENTATION_INCOMPLETE` with `{gates}` unless extensionPaired && scopesSaved && canvasConnected.
- `requireCompletedOnboarding()` unchanged in shape; `/welcome?replay=1` still works for completed users.

## Agents and file ownership (disjoint; do not edit files you don't own)
- **A: Extension.** Owns `extension/**`, `tests/extension-*.test.mjs`, `tests/grove-extension*.test.mjs`, `lib/extension/links.ts`, `public/downloads/` (new 0.4.0 zip, keep old zips). Reference only (half-done, unverified, older design): `D:` scratch copies are not available to you. Start from the branch code.
- **B: Web sign-in plumbing + Settings card + connect page.** Owns `lib/extension/web-bridge.ts`, `lib/extension/use-extension.ts`, `lib/extension/use-canvas-signin.ts` (all new), `components/ui/canvas-session.tsx`, `components/workspace/extension-connect.tsx`, `components/workspace/extension-setup.tsx`, `components/workspace/extension.module.css`, `app/extension/**`, related tests (new `tests/web-bridge.test.ts` etc.).
- **C: Scopes + onboarding backend + Settings scopes section.** Owns `lib/scopes/**` (new), `lib/db/schema.ts`, `drizzle/**`, `app/api/settings/**` (new), `lib/onboarding.ts`, `app/api/onboarding/**`, `lib/sync/**`, `scripts/sync-worker.ts`, `lib/mcp/**`, `app/oauth/**`, `app/api/canvas/mcp/**`, `components/workspace/scopes-settings.tsx` (+ its module css), `components/workspace/settings-screen.tsx`, related tests.
- **D: Orientation UI.** Owns `components/orientation/**` (new; split the wizard into one file per step), `components/ui/orientation.tsx` (replace with a re-export or delete and update imports in `app/welcome/page.tsx`), `components/ui/orientation.test.ts`, `app/welcome/**`, `components/workspace/connect-agent/**` (add an embedded variant for step 6), `app/ui-preview/orientation/**` (new fixture preview), and **all `.orientation*` / `.school-*` rules in `app/globals.css`, `app/motion.css`, `app/theme.css`** (move them into `components/orientation/orientation.module.css`; touch nothing else in those three files).
- Nobody edits `app/theme.css` tokens. If a token is missing, D adds it at the end of the module file locally and lists it in the report.

Until a dependency lands, code against the contract above (stub locally inside your own files if you must; never create a file another agent owns).

## Verification (every agent)
- Typecheck: `~/projects/canvas/worktrees/wt-node.sh 'node_modules/.bin/tsc --noEmit -p .'` (runs in the app image with the dev node_modules volume; ~20 s). Other agents' in-flight work may cause transient errors in files you don't own; report them, don't fix them.
- TS tests: `~/projects/canvas/worktrees/wt-node.sh 'node_modules/.bin/tsx --test tests/<file>.test.ts'`. Extension `.mjs` tests: `node --test tests/<file>.test.mjs` on the host.
- Lint the files you touched: `~/projects/canvas/worktrees/wt-node.sh 'node_modules/.bin/eslint <paths>'`.
- Remote shell is fish: always `ssh jossaya@jc-homelab bash -s <<'EOF' ... EOF`.
- Project rule: never act as another Grove user. DB reads only via `./ops-psql.sh` in `~/projects/canvas/web/my-clerk-next-app` (dev owner, RLS). No live Canvas requests are needed for this work. Don't read or print cookie/token values.

## Design brief (all UI: orientation, Settings sections, connect page, extension interstitial, side panel, popup)
Use the existing tokens in `app/theme.css` (neutral surfaces, one accent `--accent-primary`, semantic status colours, light+dark). The extension copies the same tokens (as `popup.css` does today).

Avoid (vibe-coded tells): gradients and glow; cards nested in cards; everything centered; an icon in a tinted square on every row; emoji; filler copy ("Seamlessly", "Unlock", "Let's get you set up!"); eyebrow/pill on every block; off-scale spacing; weak type hierarchy; several primary buttons per view; fake progress or timer-driven bars; decorative staggered animation or confetti; happy-path-only states; "Something went wrong"; walls of checkmarks for permissions; the decorative "orbit" visual in the current orientation.

Do:
- One left edge, wizard content max-width ~520-560px; left-aligned text and forms.
- Type scale 12/13/14/16/20/28, weights 400/500/600. Spacing scale 4/8/12/16/24/32/48. Radius scale (6/10) used consistently. No hard-coded colours or arbitrary px in components.
- Borders and surface tone for hierarchy; shadows only for overlays.
- One primary button per view; its label states the outcome ("Install extension", "Continue to UF Canvas", "Allow and continue"). Disabled buttons say why (helper text).
- Step indicator is a status ("Step 3 of 7 · Install extension" + named list); completed steps clickable; future steps not.
- Detect, don't ask: auto-advance the gate state (not the step) when the extension appears or sign-in completes; show a one-line concrete success ("Signed in as Jane Doe on ufl.instructure.com"), then the user presses Continue (or auto-continue after ~800 ms on the sign-in step only).
- Waiting states (extension install, sign-in in another tab): say what we're waiting for, where to act ("Finish signing in in the tab that just opened"), what we're watching for, a calm indicator, "Reopen sign-in tab" and "Cancel" actions, and a fallback after ~20 s (e.g. "Not seeing the tab?" with troubleshooting).
- Every async surface: loading, empty, error (what happened + one fix + retry, inline next to the thing), success. Errors keep the user's progress.
- Scopes step like a good OAuth consent screen: name who is asking and which Canvas account/host; group by plain-language outcome; one line per scope with expandable detail; required ones marked and locked; read vs act visually distinct; say what is never accessed (passwords, other sites, IdP cookies); "You can change this later in Settings".
- Real data in every state (school name, host, account name). Mono for hosts/URLs/tokens.
- `:focus-visible` rings everywhere; full keyboard flow; focus moves to the step heading on step change; `prefers-reduced-motion` respected; motion 120-200 ms, opacity/transform only, used to explain state changes.
- Responsive: 320 / 360 / 1280 px, no horizontal scroll, 16 px gutters. Side panel and popup: tighter scale.
- Copy: plain, specific, verb-led, one idea per sentence, no exclamation marks.
References to borrow from: Linear (restraint, density), Stripe Connect onboarding (waiting screens, saved progress, precise errors), Vercel integration install (scope lists, mono for technical values), GitHub/Google OAuth consent (named app + account, grouped revocable permissions).

## Report format (every agent, ≤ 300 words)
Files changed (one line each), contract deviations (if any, with reason), verification commands run with verbatim pass/fail counts, open issues / things only a real browser can confirm.
