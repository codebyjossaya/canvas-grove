import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ConnectAgentButton } from "@/components/workspace/connect-agent/connect-agent-button";
import { ConnectionsSection } from "@/components/workspace/connect-agent/connections-list";
import { PREVIEW_FIXTURE } from "@/components/workspace/connect-agent/use-connections";
import { ThemeControl } from "@/components/ui/theme-provider";
import { getAgent, type Workflow } from "@/lib/connect-agent/catalog";

// Public fixture preview, no auth and no network. Examples:
//   ?open=1                          dialog, agent grid
//   ?open=1&filter=ide               grid filtered to IDE
//   ?open=1&agent=claude-code        OAuth guide
//   ?open=1&agent=claude-code&mode=token            token creation form
//   ?open=1&agent=claude-code&mode=token&token=1    after creation (fixture token, snippets filled in)
//   ?open=1&agent=cursor             deeplink + .cursor/mcp.json
//   Theme: use the toggle on the page (or set data-theme).
type Search = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export default function ConnectAgentPreviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  return <Suspense fallback={<div className="boot" />}><Gate searchParams={searchParams} /></Suspense>;
}

async function Gate({ searchParams }: { searchParams: Promise<Search> }) {
  await connection();
  if (process.env.NODE_ENV === "production" && process.env.UI_FORWARD_PREVIEW !== "1") notFound();
  const query = await searchParams;
  const filter = one(query.filter);
  const initial = {
    agent: getAgent(one(query.agent))?.id,
    mode: one(query.mode) === "token" ? ("token" as const) : one(query.mode) === "oauth" ? ("oauth" as const) : undefined,
    filter: (["app", "terminal", "ide"].includes(filter ?? "") ? filter : "all") as Workflow | "all",
    token: one(query.token) ? "gmt1.preview-owner.preview-token.EXAMPLE-NOT-A-REAL-TOKEN" : undefined,
  };
  return <main className="page" style={{ display: "grid", gap: "var(--space-8)" }}>
    <header className="page-head"><div><h1>Connect agent preview</h1><p>Fixture data. No network.</p></div><div className="page-actions"><ThemeControl allowSystemReset /></div></header>
    <section aria-label="Dashboard header">
      <header className="page-head"><div><h1>Today</h1><p>Dashboard-style header</p></div><div className="page-actions"><ConnectAgentButton fixture={PREVIEW_FIXTURE} initial={initial} initialOpen={one(query.open) === "1"} /></div></header>
    </section>
    <section aria-label="Settings header">
      <header className="page-head"><div><h1>Settings</h1><p>Settings-style header</p></div><div className="page-actions"><ConnectAgentButton fixture={PREVIEW_FIXTURE} /></div></header>
      <div className="panel"><h2>Agents (MCP)</h2><ConnectionsSection fixture={PREVIEW_FIXTURE} /></div>
    </section>
  </main>;
}
