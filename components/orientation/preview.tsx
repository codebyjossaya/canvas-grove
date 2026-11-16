"use client";

import { useState, type ReactNode } from "react";
import type { UiError } from "@/components/ui/ui-errors";
import { PREVIEW_FIXTURE, useConnections, type ConnectionsData } from "@/components/workspace/connect-agent/use-connections";
import { DEFAULT_SCOPES, type ScopeSettings } from "@/lib/scopes/catalog";
import { stepIndex, type ExtensionView, type SignInView, type StepId } from "./model";
import { Mono, OrientationShell } from "./shell";
import { StepAgent } from "./step-agent";
import { StepDone, type SummaryRow } from "./step-done";
import { StepExtension } from "./step-extension";
import { StepSchool } from "./step-school";
import { StepScopes } from "./step-scopes";
import { StepSignIn } from "./step-signin";
import { StepWelcome } from "./step-welcome";

// Fixture gallery for /ui-preview/orientation. No network, no extension: every step in every
// state, with realistic values. `?s=<key>` renders one state; no key lists them all.

const SCHOOL = { name: "University of Florida", domain: "ufl.instructure.com" };
const RESULTS = [
  SCHOOL,
  { name: "Florida State University", domain: "canvas.fsu.edu" },
  { name: "Florida International University", domain: "fiu.instructure.com" },
];
const noop = () => undefined;
const asyncNoop = async () => undefined;
const ext = (status: ExtensionView["status"], version: string | null = "0.4.0", deviceName: string | null = null): ExtensionView => ({ status, version, deviceName });
const signin = (phase: SignInView["phase"], extra: Partial<SignInView> = {}): SignInView => ({ phase, accountName: null, canvasOrigin: "https://ufl.instructure.com", error: null, existing: null, ...extra });
const PAIR_ERROR: UiError = { code: "UNKNOWN", title: "This browser was not connected", message: "The extension did not answer within 5 seconds. Nothing was saved.", nextAction: "Try again. If it keeps failing, reload this page." };
const SIGNIN_ERROR: UiError = { code: "CAPTURE_REJECTED", title: "Canvas did not accept that session", message: "The sign-in tab closed, but Canvas reported the session as signed out before Grove could check it.", nextAction: "Sign in again and wait for the tab to close by itself." };
const SAVE_ERROR: UiError = { code: "NETWORK_OFFLINE", title: "This device appears to be offline", message: "Your selections are still here.", nextAction: "Check your network connection, then try again." };
const SAVED: ScopeSettings = { data: ["courses", "assignments", "grades", "announcements", "quizzes", "content"], agent: { access: "propose", autoCategories: ["submit_assignment"] }, savedAt: "2026-11-15T18:00:00Z" };
const NO_CONNECTIONS: ConnectionsData = { serverUrl: PREVIEW_FIXTURE.serverUrl, tokens: [], grants: [] };

const ROWS = (agent: ReactNode, pendingAgent = false): SummaryRow[] => [
  { step: "school", label: "School", value: <>{SCHOOL.name} <Mono>{SCHOOL.domain}</Mono></> },
  { step: "extension", label: "Browser", value: "Chrome on Windows, extension 0.4.0" },
  { step: "scopes", label: "Grove reads", value: "6 of 7 Canvas areas. Agents: read and propose actions." },
  { step: "signin", label: "Canvas", value: <>Jordan Lee on <Mono>{SCHOOL.domain}</Mono></> },
  { step: "agent", label: "AI agent", value: agent, pending: pendingAgent },
];

type State = { key: string; step: StepId; label: string; render: () => ReactNode };
const STATES: State[] = [
  { key: "welcome", step: "welcome", label: "Welcome", render: () => <StepWelcome onNext={noop} /> },
  { key: "school-empty", step: "school", label: "School: empty", render: () => <StepSchool school={null} onSelect={noop} onBack={noop} onNext={noop} /> },
  { key: "school-results", step: "school", label: "School: results", render: () => <StepSchool school={null} onSelect={noop} onBack={noop} onNext={noop} initialQuery="florida" initialResults={RESULTS} initialStatus="done" /> },
  { key: "school-none", step: "school", label: "School: no match", render: () => <StepSchool school={null} onSelect={noop} onBack={noop} onNext={noop} initialQuery="florda stat" initialResults={[]} initialStatus="done" /> },
  { key: "school-selected", step: "school", label: "School: selected", render: () => <StepSchool school={SCHOOL} onSelect={noop} onBack={noop} onNext={noop} /> },
  ...(["checking", "missing", "outdated", "unpaired", "ready"] as const).map((status): State => ({
    key: `ext-${status}`, step: "extension", label: `Extension: ${status}`,
    render: () => <StepExtension ext={status === "outdated" ? ext(status, "0.3.2") : status === "ready" ? ext(status, "0.4.0", "Chrome on Windows") : status === "checking" || status === "missing" ? ext(status, null) : ext(status)} downloadUrl="/downloads/grove-for-canvas-0.4.0.zip" minVersion="0.4.0" extensionsPage="chrome://extensions" defaultBrowserName="Chrome on Windows" onPair={asyncNoop} onReload={noop} onBack={noop} onNext={noop} />,
  })),
  { key: "ext-missing-fallback", step: "extension", label: "Extension: missing, after 20 s", render: () => <StepExtension ext={ext("missing", null)} downloadUrl="/downloads/grove-for-canvas-0.4.0.zip" minVersion="0.4.0" extensionsPage="chrome://extensions" defaultBrowserName="Chrome on Windows" onPair={asyncNoop} onReload={noop} onBack={noop} onNext={noop} fallbackAfterMs={0} /> },
  { key: "ext-pair-error", step: "extension", label: "Extension: pairing failed", render: () => <StepExtension ext={ext("unpaired")} downloadUrl="/downloads/grove-for-canvas-0.4.0.zip" minVersion="0.4.0" extensionsPage="chrome://extensions" defaultBrowserName="Chrome on Windows" onPair={asyncNoop} onReload={noop} onBack={noop} onNext={noop} initialPairError={PAIR_ERROR} /> },
  { key: "scopes", step: "scopes", label: "Scopes: defaults", render: () => <ScopesFixture initial={DEFAULT_SCOPES} /> },
  { key: "scopes-saved", step: "scopes", label: "Scopes: saved, auto defaults open", render: () => <ScopesFixture initial={SAVED} /> },
  { key: "scopes-loading", step: "scopes", label: "Scopes: loading", render: () => <ScopesFixture initial={DEFAULT_SCOPES} load="loading" /> },
  { key: "scopes-error", step: "scopes", label: "Scopes: load and save failed", render: () => <ScopesFixture initial={DEFAULT_SCOPES} load="error" saveError={SAVE_ERROR} /> },
  { key: "signin-idle", step: "signin", label: "Sign-in: idle", render: () => <SignIn view={signin("idle")} /> },
  { key: "signin-starting", step: "signin", label: "Sign-in: starting", render: () => <SignIn view={signin("starting")} /> },
  { key: "signin-awaiting", step: "signin", label: "Sign-in: waiting for tab click", render: () => <SignIn view={signin("awaiting-tab-click")} /> },
  { key: "signin-waiting", step: "signin", label: "Sign-in: signing in", render: () => <SignIn view={signin("signing-in")} /> },
  { key: "signin-fallback", step: "signin", label: "Sign-in: signing in, after 20 s", render: () => <SignIn view={signin("signing-in")} fallbackAfterMs={0} /> },
  { key: "signin-tab-closed", step: "signin", label: "Sign-in: tab closed", render: () => <SignIn view={signin("signing-in", { tabClosed: true })} /> },
  { key: "signin-verifying", step: "signin", label: "Sign-in: verifying", render: () => <SignIn view={signin("verifying")} /> },
  { key: "signin-error", step: "signin", label: "Sign-in: error", render: () => <SignIn view={signin("error", { error: SIGNIN_ERROR })} /> },
  { key: "signin-connected", step: "signin", label: "Sign-in: connected", render: () => <SignIn view={signin("connected", { accountName: "Jordan Lee" })} /> },
  { key: "signin-existing", step: "signin", label: "Sign-in: already connected (replay)", render: () => <SignIn view={signin("idle", { canvasOrigin: null, existing: { connected: true, canvasOrigin: "https://ufl.instructure.com", accountName: "Jordan Lee" } })} /> },
  { key: "agent-none", step: "agent", label: "Agent: none", render: () => <AgentFixture data={NO_CONNECTIONS} /> },
  { key: "agent-guide", step: "agent", label: "Agent: Claude Code guide", render: () => <AgentFixture data={NO_CONNECTIONS} initialAgent="claude-code" /> },
  { key: "agent-connected", step: "agent", label: "Agent: just connected", render: () => <AgentFixture data={PREVIEW_FIXTURE} detected /> },
  { key: "done", step: "done", label: "Done", render: () => <StepDone rows={ROWS(<>Claude</>)} finishing={false} error={null} missing={[]} onGoTo={noop} onFinish={noop} onBack={noop} /> },
  { key: "done-no-agent", step: "done", label: "Done: no agent", render: () => <StepDone rows={ROWS("None yet. Add one anytime from Settings.", true)} finishing={false} error={null} missing={[]} onGoTo={noop} onFinish={noop} onBack={noop} /> },
  { key: "done-incomplete", step: "done", label: "Done: server says incomplete", render: () => <StepDone rows={ROWS(<>Claude</>)} finishing={false} error={null} missing={["signin"]} onGoTo={noop} onFinish={noop} onBack={noop} /> },
];

function SignIn({ view, fallbackAfterMs }: { view: SignInView; fallbackAfterMs?: number }) {
  return <StepSignIn view={view} school={SCHOOL} onStart={noop} onFocusTab={noop} onCancel={noop} onRetry={noop} onBack={noop} onNext={noop} fallbackAfterMs={fallbackAfterMs} />;
}

function ScopesFixture({ initial, load = "ready", saveError = null }: { initial: ScopeSettings; load?: "loading" | "ready" | "error"; saveError?: UiError | null }) {
  const [draft, setDraft] = useState(initial);
  return <StepScopes school={SCHOOL} draft={draft} onChange={setDraft} load={{ status: load }} onRetryLoad={noop} saving={false} saveError={saveError} onSave={noop} onBack={noop} />;
}

function AgentFixture({ data, detected = false, initialAgent }: { data: ConnectionsData; detected?: boolean; initialAgent?: "claude-code" }) {
  const connections = useConnections(data);
  return <StepAgent connections={connections} access="propose" detected={detected ? { key: "g-g1", name: "Claude", kind: "OAuth" } : null} existing={[]} onEditAccess={noop} onBack={noop} onNext={noop} initialAgent={initialAgent} />;
}

const COMPLETE = [true, true, true, true, true, true, false];

export function OrientationPreview({ stateKey }: { stateKey?: string }) {
  const one = STATES.find((state) => state.key === stateKey);
  if (one) {
    const index = stepIndex(one.step);
    return <OrientationShell step={index} reachable={index} complete={COMPLETE.map((value, i) => value && i < index)} focusOnChange={false}>{one.render()}</OrientationShell>;
  }
  return <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-12) var(--space-4)", display: "grid", gap: "var(--space-4)" }}>
    <h1 style={{ fontSize: "var(--fs-xl)" }}>Orientation states</h1>
    <p style={{ color: "var(--text-muted)" }}>Fixture data, no network and no extension. Open a state to see it full page.</p>
    <ol style={{ display: "grid", gap: "var(--space-1)", paddingLeft: "var(--space-6)" }}>
      {STATES.map((state) => <li key={state.key}><a style={{ color: "var(--accent-text)", textDecoration: "underline" }} href={`?s=${state.key}`}>{state.label}</a> <code style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>{state.key}</code></li>)}
    </ol>
  </main>;
}

