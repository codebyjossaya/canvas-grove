import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ThemeControl } from "@/components/ui/theme-provider";
import { ApprovalsBadge } from "@/components/workspace/approvals/approvals-badge";
import { ApprovalsScreen } from "@/components/workspace/approvals/approvals-screen";
import { fixtureAutoTargets, fixturePayload, type AutoScenario } from "@/components/workspace/approvals/fixtures";
import { ConnectionsSection } from "@/components/workspace/connect-agent/connections-list";
import { PREVIEW_FIXTURE } from "@/components/workspace/connect-agent/use-connections";

// Public fixture preview: no auth, no network. Theme: use the toggle (or ?theme= if the shell honours it).
//   /ui-preview/approvals                          awaiting list + auto mode (off)
//   ?view=awaiting | history | empty | error | loading | history-empty
//   ?only=approvals | auto                         show just one section
//   ?auto=off | on | expiring | capped | readonly
//   ?setup=1                                       auto-mode setup form open on "Claude Code on laptop" (nothing preselected)
//   ?confirm=1                                     confirmation dialog open (submit_assignment + quiz_entry, 8 h)
//   quiz-entry card: it is in the default awaiting list ("Start graded quiz: Chapter 4 check", expiring soon)
type Search = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
const SCENARIOS: AutoScenario[] = ["off", "on", "expiring", "capped", "readonly"];

export default function ApprovalsPreviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  return <Suspense fallback={<div className="boot" />}><Gate searchParams={searchParams} /></Suspense>;
}

async function Gate({ searchParams }: { searchParams: Promise<Search> }) {
  await connection();
  if (process.env.NODE_ENV === "production" && process.env.UI_FORWARD_PREVIEW !== "1") notFound();
  const query = await searchParams;
  const now = new Date().getTime();
  const view = one(query.view) ?? "awaiting";
  const only = one(query.only);
  const scenario = SCENARIOS.find(item => item === one(query.auto)) ?? "off";
  const history = view === "history" || view === "history-empty";
  const awaitingFixture = view === "empty" ? { awaitingCount: 0, actions: [] } : view === "error" ? ("error" as const) : view === "loading" ? ("loading" as const) : fixturePayload(now, "awaiting");
  const historyFixture = view === "history-empty" ? { awaitingCount: 0, actions: [] } : fixturePayload(now, "history");
  const confirm = one(query.confirm) === "1", setup = one(query.setup) === "1" || confirm;
  const autoPreview = setup ? { "token:t1": { open: true, confirm, categories: confirm ? ["submit_assignment", "quiz_entry"] : [] } } : undefined;
  return <div className="page" style={{ display: "grid", gap: "var(--space-8)" }}>
    <header className="page-head"><div><h1>Approvals preview</h1><p>Fixture data. No network. Sidebar badge: <ApprovalsBadge count={3} /></p></div><div className="page-actions"><ThemeControl allowSystemReset /></div></header>
    {only !== "auto" ? <ApprovalsScreen key={view} fixture={{ awaiting: awaitingFixture, history: historyFixture }} initialTab={history ? "history" : "awaiting"} /> : null}
    {only !== "approvals" ? <section className="panel" aria-labelledby="auto-h"><h2 id="auto-h">Agents (MCP): auto mode ({scenario})</h2><ConnectionsSection fixture={PREVIEW_FIXTURE} autoTargets={fixtureAutoTargets(now, scenario)} autoPreview={autoPreview} /></section> : null}
  </div>;
}
