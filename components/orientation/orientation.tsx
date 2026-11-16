"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toUiError, type UiError } from "@/components/ui/ui-errors";
import { useConnections } from "@/components/workspace/connect-agent/use-connections";
import { EXTENSION_DOWNLOAD_URL, EXTENSION_MIN_VERSION } from "@/lib/extension/links";
import { useCanvasSignIn } from "@/lib/extension/use-canvas-signin";
import { useExtension } from "@/lib/extension/use-extension";
import { AGENT_ACCESS_INFO, DATA_SCOPES, DEFAULT_SCOPES, type ScopeSettings } from "@/lib/scopes/catalog";
import {
  ORIENTATION_STEPS, agentConnections, extensionsPageFor, firstBlockedStep, guessBrowserName, hostOf, missingSteps, newlyConnected, resumeStep, stepIndex,
  type ExtensionView, type GateState, type OnboardingGates, type School, type SignInView, type StepId,
} from "./model";
import { Mono, OrientationShell } from "./shell";
import { StepAgent } from "./step-agent";
import { StepDone, type SummaryRow } from "./step-done";
import { StepExtension } from "./step-extension";
import { StepSchool } from "./step-school";
import { StepScopes, type ScopesLoad } from "./step-scopes";
import { StepSignIn } from "./step-signin";
import { StepWelcome } from "./step-welcome";
import styles from "./orientation.module.css";

export { ORIENTATION_STEPS } from "./model";

const SCHOOL_KEY = "grove.orientation.school";
const CSRF = { "content-type": "application/json", "x-grove-csrf": "1" };
const AUTO_CONTINUE_MS = 800;
const RESUME_WAIT_MS = 2500;
const AGENT_POLL_MS = 4000;
const noop = () => () => undefined;

/** Per-browser convenience only: the server never needs it, and losing it just asks again. */
function readSchool(): School | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(SCHOOL_KEY) ?? "null") as School | null;
    return value && typeof value.name === "string" && typeof value.domain === "string" ? value : null;
  } catch { return null; }
}
function writeSchool(school: School | null) {
  try { if (school) window.localStorage.setItem(SCHOOL_KEY, JSON.stringify(school)); else window.localStorage.removeItem(SCHOOL_KEY); } catch { /* storage blocked */ }
}

type Onboarding = { status: "loading" | "ready" | "error"; completed: boolean; gates: Partial<OnboardingGates> };

export function Orientation() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [visited, setVisited] = useState(0);
  const [direction, setDirection] = useState<"forward" | "backward">("forward");
  const [school, setSchoolState] = useState<School | null>(null);
  const [restored, setRestored] = useState(false);
  const [onboarding, setOnboarding] = useState<Onboarding>({ status: "loading", completed: false, gates: {} });
  const [resumed, setResumed] = useState(false);
  const interacted = useRef(false);

  const [draft, setDraft] = useState<ScopeSettings>(DEFAULT_SCOPES);
  const [scopesLoad, setScopesLoad] = useState<ScopesLoad>({ status: "loading" });
  const [scopesNonce, setScopesNonce] = useState(0);
  const [savingScopes, setSavingScopes] = useState(false);
  const [scopesError, setScopesError] = useState<UiError | null>(null);

  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<UiError | null>(null);
  const [missing, setMissing] = useState<StepId[]>([]);

  const ext = useExtension();
  const signin = useCanvasSignIn({ school });
  const connections = useConnections(undefined, { pollMs: step === stepIndex("agent") ? AGENT_POLL_MS : 0 });
  const [baseline, setBaseline] = useState<string[] | null>(null);

  const browserName = useSyncExternalStore(noop, () => guessBrowserName(navigator.userAgent), () => "This browser");
  const extensionsPage = useSyncExternalStore(noop, () => extensionsPageFor(navigator.userAgent), () => "chrome://extensions");

  // Restore the school chosen earlier in this browser.
  useEffect(() => {
    const stored = readSchool();
    queueMicrotask(() => { setSchoolState(stored); setRestored(true); });
  }, []);

  // Server-side gates (contract 4).
  useEffect(() => {
    let live = true;
    fetch("/api/onboarding", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ completed?: boolean; gates?: Partial<OnboardingGates> }> : Promise.reject(new Error("onboarding")))
      .then((body) => { if (live) setOnboarding({ status: "ready", completed: Boolean(body.completed), gates: body.gates ?? {} }); })
      .catch(() => { if (live) setOnboarding((previous) => ({ ...previous, status: "error" })); });
    return () => { live = false; };
  }, []);

  // Saved scopes (contract 3). A failed load shows defaults and says so.
  useEffect(() => {
    let live = true;
    fetch("/api/settings/scopes", { headers: { "x-grove-csrf": "1" }, cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<ScopeSettings> : Promise.reject(new Error("scopes")))
      .then((body) => { if (live) { setDraft(body); setScopesLoad({ status: "ready" }); } })
      .catch(() => { if (live) setScopesLoad({ status: "error" }); });
    return () => { live = false; };
  }, [scopesNonce]);

  // Connections present when the page loaded; anything new after that counts as "just connected".
  const current = useMemo(() => agentConnections(connections.state.data), [connections.state.data]);
  useEffect(() => {
    if (baseline === null && connections.state.data) queueMicrotask(() => setBaseline(current.map((item) => item.key)));
  }, [baseline, connections.state.data, current]);
  const detected = newlyConnected(baseline, current);
  const existing = baseline ? current.filter((item) => baseline.includes(item.key)) : [];

  const extensionView: ExtensionView = { status: ext.status, version: ext.state?.version ?? null, deviceName: ext.state?.deviceName ?? null };
  const signInView: SignInView = { phase: signin.phase, accountName: signin.account?.name ?? null, canvasOrigin: signin.session?.canvasOrigin ?? null, error: signin.error, existing: signin.existing, tabClosed: signin.tabClosed };
  const canvasConnected = signin.phase === "connected" || Boolean(signin.existing?.connected) || (signin.phase === "idle" && Boolean(onboarding.gates.canvasConnected));
  const gates: GateState = {
    school,
    extensionReady: ext.status === "ready",
    scopesSaved: Boolean(onboarding.gates.scopesSaved || draft.savedAt),
    canvasConnected,
    agentConnected: Boolean(onboarding.gates.agentConnected) || current.length > 0,
  };
  const blocked = firstBlockedStep(gates);
  const reachable = Math.max(step, Math.min(visited, blocked));
  const complete = [visited > 0, Boolean(school), gates.extensionReady, gates.scopesSaved, gates.canvasConnected, gates.agentConnected, false];

  // Resume once, from real state, unless the user already started clicking. Waits for the
  // extension check to settle (it answers in well under a second when installed).
  const latestGates = useRef(gates);
  useEffect(() => { latestGates.current = gates; });
  const extensionSettled = ext.status !== "checking" && !signin.loading;
  useEffect(() => {
    if (resumed || !restored || onboarding.status === "loading") return;
    const settle = () => {
      setResumed(true);
      if (interacted.current) return;
      const state = latestGates.current;
      const target = onboarding.completed ? 0 : resumeStep(state);
      const furthest = onboarding.completed ? Math.max(resumeStep(state), stepIndex("agent")) : target;
      setVisited((value) => Math.max(value, furthest));
      setStep(target);
    };
    const timer = window.setTimeout(settle, extensionSettled ? 0 : RESUME_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [resumed, restored, onboarding.status, onboarding.completed, extensionSettled]);

  const goTo = useCallback((next: number) => {
    interacted.current = true;
    const bounded = Math.max(0, Math.min(ORIENTATION_STEPS.length - 1, next));
    setDirection(bounded >= step ? "forward" : "backward");
    setStep(bounded);
    setVisited((value) => Math.max(value, bounded));
    setFinishError(null); setMissing([]);
  }, [step]);
  const next = useCallback(() => goTo(step + 1), [goTo, step]);
  const back = useCallback(() => goTo(step - 1), [goTo, step]);

  // Sign-in completes in another tab: show the success line, then move on by itself.
  const lastPhase = useRef(signin.phase);
  useEffect(() => {
    const previous = lastPhase.current;
    lastPhase.current = signin.phase;
    if (signin.phase !== "connected" || previous === "connected" || previous === "idle" || step !== stepIndex("signin")) return;
    const timer = window.setTimeout(() => goTo(stepIndex("agent")), AUTO_CONTINUE_MS);
    return () => window.clearTimeout(timer);
  }, [signin.phase, step, goTo]);

  function selectSchool(value: School | null) {
    interacted.current = true;
    setSchoolState(value);
    writeSchool(value);
  }

  async function saveScopes() {
    if (savingScopes) return;
    setSavingScopes(true); setScopesError(null);
    try {
      const response = await fetch("/api/settings/scopes", { method: "PUT", headers: CSRF, body: JSON.stringify({ data: draft.data, agent: draft.agent }) });
      const body = await response.json().catch(() => null) as (ScopeSettings & { error?: string }) | null;
      if (!response.ok || !body) throw new Error(body?.error || "scopes not saved");
      setDraft({ ...body, savedAt: body.savedAt ?? new Date().toISOString() });
      setOnboarding((previous) => ({ ...previous, gates: { ...previous.gates, scopesSaved: true } }));
      goTo(stepIndex("signin"));
    } catch (caught) {
      const error = toUiError(caught, typeof navigator !== "undefined" && !navigator.onLine ? "NETWORK_OFFLINE" : "UNKNOWN");
      setScopesError(error.code === "UNKNOWN" ? { ...error, title: "Your choices were not saved", message: "Nothing changed on the server, and your selections are still here.", nextAction: "Try again." } : error);
    } finally { setSavingScopes(false); }
  }

  async function finish() {
    if (finishing) return;
    setFinishing(true); setFinishError(null); setMissing([]);
    try {
      const response = await fetch("/api/onboarding", { method: "POST", headers: CSRF, body: JSON.stringify({ completed: true }) });
      const body = await response.json().catch(() => null) as { error?: string; code?: string; gates?: Partial<OnboardingGates> } | null;
      if (response.status === 409) {
        const steps = missingSteps(body?.gates);
        setMissing(steps.length ? steps : ["extension", "scopes", "signin"]);
        setFinishing(false);
        return;
      }
      if (!response.ok) throw new Error(body?.error || "Onboarding completion is temporarily unavailable");
      writeSchool(null);
      router.push("/");
      router.refresh();
    } catch (caught) {
      const error = toUiError(caught, !navigator.onLine ? "NETWORK_OFFLINE" : "UNKNOWN");
      setFinishError(error.code === "UNKNOWN" ? { ...error, title: "Grove could not finish setup", message: "Everything you set up is saved.", nextAction: "Try again in a moment." } : error);
      setFinishing(false);
    }
  }

  const host = hostOf(signInView.canvasOrigin ?? signin.existing?.canvasOrigin ?? school?.domain);
  const accountName = signInView.accountName ?? signin.existing?.accountName ?? null;
  const agents = detected ? [detected, ...existing] : existing.length ? existing : current;
  const summary: SummaryRow[] = [
    { step: "school", label: "School", value: school ? <>{school.name} <Mono>{hostOf(school.domain)}</Mono></> : "Not chosen", pending: !school },
    { step: "extension", label: "Browser", value: extensionView.status === "ready" ? `${extensionView.deviceName ?? "This browser"}, extension ${extensionView.version ?? ""}`.trim() : "Extension not connected", pending: extensionView.status !== "ready" },
    { step: "scopes", label: "Grove reads", value: `${draft.data.length} of ${DATA_SCOPES.length} Canvas areas. Agents: ${AGENT_ACCESS_INFO[draft.agent.access].label.toLowerCase()}.` },
    { step: "signin", label: "Canvas", value: canvasConnected ? <>{accountName ? `${accountName} on ` : "Signed in on "}<Mono>{host}</Mono></> : "Not signed in", pending: !canvasConnected },
    { step: "agent", label: "AI agent", value: agents.length ? agents.map((item) => item.name).join(", ") : "None yet. Add one anytime from Settings.", pending: !agents.length },
  ];

  const id = ORIENTATION_STEPS[step].id;
  const waitingForResume = !resumed && restored && Boolean(school);
  return <OrientationShell step={step} reachable={reachable} complete={complete} onNavigate={goTo} direction={direction}>
    {waitingForResume ? <div className={styles.resuming} role="status" aria-live="polite"><span className={styles.pulse} aria-hidden="true" />Picking up where you left off…</div>
      : id === "welcome" ? <StepWelcome onNext={next} />
        : id === "school" ? <StepSchool school={school} onSelect={selectSchool} onBack={back} onNext={next} />
          : id === "extension" ? <StepExtension ext={extensionView} downloadUrl={EXTENSION_DOWNLOAD_URL} minVersion={EXTENSION_MIN_VERSION} extensionsPage={extensionsPage} defaultBrowserName={browserName} onPair={ext.pair} onReload={() => window.location.reload()} onBack={back} onNext={next} />
            : id === "scopes" ? <StepScopes school={school} accountName={accountName} draft={draft} onChange={setDraft} load={scopesLoad} onRetryLoad={() => { setScopesLoad({ status: "loading" }); setScopesNonce((value) => value + 1); }} saving={savingScopes} saveError={scopesError} onSave={() => void saveScopes()} onBack={back} />
              : id === "signin" ? <StepSignIn view={signInView} school={school} onStart={() => void signin.start()} onFocusTab={signin.focusTab} onCancel={() => void signin.cancel()} onRetry={() => void signin.retry()} onBack={back} onNext={next} />
                : id === "agent" ? <StepAgent connections={connections} access={draft.agent.access} detected={detected} existing={existing} onEditAccess={() => goTo(stepIndex("scopes"))} onBack={back} onNext={next} />
                  : <StepDone rows={summary} finishing={finishing} error={finishError} missing={missing} onGoTo={(target) => goTo(stepIndex(target))} onFinish={() => void finish()} onBack={back} />}
  </OrientationShell>;
}
