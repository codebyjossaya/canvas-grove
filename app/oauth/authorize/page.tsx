import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { GroveMark } from "@/components/ui/icons";
import { READ_SCOPE_TEXT, WRITE_SCOPE_TEXT } from "@/lib/mcp/categories";
import { consentToken, validateAuthorizeRequest } from "@/lib/mcp/authorize";
import { MCP_LIMITS, limit } from "@/lib/mcp/limits";
import { publicOrigin } from "@/lib/mcp/origin";
import { decideConsent } from "./actions";
import styles from "./consent.module.css";

export const metadata: Metadata = { title: "Connect an app · Canvas Grove", robots: { index: false, follow: false }, referrer: "no-referrer" };

type Search = Promise<Record<string, string | string[] | undefined>>;

/** OAuth consent for Grove's MCP server. Framing is blocked in proxy.ts (frame-ancestors 'none'). */
export default function AuthorizePage({ searchParams }: { searchParams: Search }) {
  return <Suspense fallback={<main className={styles.stage} aria-busy="true"/>}><Consent searchParams={searchParams}/></Suspense>;
}

function Shell({ children }: { children: ReactNode }) {
  return <main className={styles.stage}><div className={styles.card}>
    <div className={styles.brand}><GroveMark/><span>Canvas Grove</span></div>
    {children}
  </div></main>;
}

function Problem({ message }: { message: string }) {
  return <Shell><section className={`panel ${styles.panel}`}>
    <h1 className={styles.title}>This connection can&apos;t continue</h1>
    <p className={styles.lead}>{message}</p>
    <p className={styles.fine}>Go back to the app and start connecting again. If it keeps happening, the app may be misconfigured.</p>
  </section></Shell>;
}

async function Consent({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const origin = publicOrigin(await headers(), null);
  if (!origin) return <Problem message="Grove could not determine its own address for this request."/>;
  const { userId } = await auth();
  if (!userId) {
    const query = new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : []))).toString();
    redirect(`/sign-in?redirect_url=${encodeURIComponent(`/oauth/authorize?${query}`)}`);
  }
  const allowed = limit(MCP_LIMITS.consent, userId);
  if (!allowed.allowed) return <Problem message="Too many connection attempts. Please wait a few minutes and try again."/>;
  const checked = await validateAuthorizeRequest(params, origin);
  if (checked.kind === "fatal") return <Problem message={checked.message}/>;
  if (checked.kind === "redirect") redirect(checked.url);
  const { client, request } = checked;
  const user = await currentUser();
  const account = user?.primaryEmailAddress?.emailAddress ?? user?.username ?? "your Grove account";
  const host = new URL(request.redirectUri).host;
  const hidden: Record<string, string> = {
    client_id: request.clientId, redirect_uri: request.redirectUri, response_type: "code", code_challenge: request.codeChallenge,
    code_challenge_method: "S256", scope: request.scopes.join(" "), ...(request.resource ? { resource: request.resource } : {}),
    ...(request.state != null ? { state: request.state } : {}), csrf: consentToken(userId, request),
  };

  return <Shell><section className={`panel ${styles.panel}`} aria-labelledby="consent-title">
    <p className={styles.eyebrow}>Connect an app</p>
    <h1 id="consent-title" className={styles.title}><span className={styles.client}>{client.clientName}</span> wants to access your Canvas Grove</h1>
    <p className={styles.lead}>The app chose this name itself. Only continue if you started this from an app you trust.</p>

    <div className={styles.destination}>
      <span>After you decide, you&apos;ll be sent to</span>
      <code className={styles.hostLarge}>{host}</code>
      <span className={styles.fine}>Only continue if this is the app you meant to connect.</span>
    </div>

    <dl className={styles.facts}>
      <div><dt>It will be able to</dt><dd>{READ_SCOPE_TEXT}</dd></div>
      <div><dt>Quizzes</dt><dd>Supported Classic Quizzes include practice, graded, survey and graded-survey assessments. Each attempt needs entry approval unless you enable quiz auto mode. Proctored and New Quizzes remain unsupported.</dd></div>
      <div><dt>Approving as</dt><dd><span className="chip accent">{account}</span></dd></div>
    </dl>

    <form action={decideConsent} className={styles.form}>
      {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value}/>)}
      {request.offerWrite ? <label className={styles.option}>
        <input type="checkbox" name="allow_actions" value="1"/>
        <span><strong>Also allow proposing actions</strong><span className={styles.fine}>{WRITE_SCOPE_TEXT}</span></span>
      </label> : null}
      <div className={styles.actions}>
      <button type="submit" name="decision" value="deny" className="button secondary large">Deny</button>
      <button type="submit" name="decision" value="approve" className="button primary large">Approve</button>
      </div>
    </form>
    <p className={styles.fine}>You can disconnect this app at any time in Grove Settings.</p>
  </section></Shell>;
}
