"use client";

/**
 * Settings → Canvas connection. Sign-in runs through the Grove extension (useCanvasSignIn); this card
 * only picks the school, asks for consent and renders the hook's state. The server decides whether
 * Canvas is connected.
 */
import { KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { ErrorNotice } from "./error-notice";
import type { UiError } from "./ui-errors";
import { AppLink } from "./app-link";
import { parseInstitutionLink } from "@/lib/canvas/institution";
import { EXTENSION_INSTALL_PATH } from "@/lib/extension/links";
import { MIN_EXTENSION_VERSION, useExtension, type ExtensionStatus } from "@/lib/extension/use-extension";
import { useCanvasSignIn, type CanvasSignIn, type SignInSchool } from "@/lib/extension/use-canvas-signin";
import styles from "./canvas-session.module.css";

const SCHOOL_SEARCH_DEBOUNCE_MS = 300;
/** After this long without progress, offer "Not seeing the tab?" help. */
const SLOW_TAB_MS = 20_000;

type School = { name: string; domain: string };
type SearchStatus = "idle" | "loading" | "done" | "error";

const hostOf = (origin: string) => { try { return new URL(origin).host; } catch { return origin; } };
const timeFormat = () => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function CanvasSessionManager() {
  const extension = useExtension();
  const [entryMode, setEntryMode] = useState<"search" | "link">("search");
  const [selectedSchool, setSelectedSchool] = useState<School | null>(null);
  const [signInLink, setSignInLink] = useState("");
  const [linkError, setLinkError] = useState("");
  const [consent, setConsent] = useState(false);
  /** The user chose "Use a different school" on an expired connection. */
  const [changingSchool, setChangingSchool] = useState(false);
  const prefillApplied = useRef(false);

  const school = pickSchool(entryMode, selectedSchool, signInLink);
  const signIn = useCanvasSignIn({ school });
  const server = signIn.serverSession;
  const reconnecting = Boolean(server && server.state !== "active" && !changingSchool);
  // When reconnecting an existing (expired or unfinished) session, sign in to that same site.
  const reconnectSchool: SignInSchool | null = server && reconnecting ? { name: server.institutionName, domain: server.canvasOrigin } : null;

  // Orientation used to hand over its school through the URL; keep honouring that link.
  useEffect(() => {
    if (prefillApplied.current) return;
    prefillApplied.current = true;
    const params = new URLSearchParams(window.location.search);
    const name = params.get("canvasSchoolName")?.trim().slice(0, 120) ?? "";
    const domain = params.get("canvasSchoolDomain")?.trim().slice(0, 300) ?? "";
    if (!name || !domain) return;
    params.delete("canvasSchoolName");
    params.delete("canvasSchoolDomain");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    try {
      parseInstitutionLink(domain);
      queueMicrotask(() => setSelectedSchool({ name, domain }));
    } catch {
      queueMicrotask(() => setLinkError("The school chosen during orientation has an invalid Canvas address. Search for it again."));
    }
  }, []);

  const inProgress = signIn.phase === "starting" || signIn.phase === "awaiting-tab-click" || signIn.phase === "signing-in" || signIn.phase === "verifying";
  const connected = Boolean(signIn.existing?.connected) && !inProgress;
  const status = signIn.loading ? null : connected ? { tone: "success", label: "Connected" }
    : inProgress ? { tone: "info", label: "Signing in" }
      : server?.state === "auth-expired" ? { tone: "warning", label: "Sign-in needed" }
        : { tone: "", label: "Not connected" };

  return (
    <section className={`panel ${styles.card}`} aria-labelledby="session-title" aria-busy={signIn.loading || signIn.phase === "starting"}>
      <header className={styles.head}>
        <div>
          <h2 id="session-title" tabIndex={-1}>Canvas connection</h2>
          <p className={styles.lede}>Grove reads your courses through a Canvas session from this browser. Your password and multi-factor codes never leave your school&apos;s sign-in page.</p>
        </div>
        {status ? <span className={`chip ${status.tone}`}>{status.label}</span> : null}
      </header>

      {signIn.loading ? (
        <p className={styles.muted} role="status">Checking your Canvas connection…</p>
      ) : connected ? (
        <Connected signIn={signIn} justConnected={signIn.phase === "connected"} />
      ) : inProgress ? (
        <Waiting signIn={signIn} schoolName={school?.name ?? server?.institutionName ?? "your school"} />
      ) : (
        <>
          {signIn.error ? <ErrorNotice error={signIn.error} onRetry={signIn.session ? () => void signIn.retry() : undefined} /> : null}
          {reconnectSchool && server ? (
            <Reconnect
              signIn={signIn}
              school={reconnectSchool}
              expired={server.state === "auth-expired"}
              extensionStatus={extension.status}
              onChangeSchool={() => setChangingSchool(true)}
            />
          ) : (
            <form className={styles.form} onSubmit={(event) => { event.preventDefault(); if (consent && school && extension.status === "ready") void signIn.start(); }}>
              <ExtensionGate status={extension.status} />
              <SchoolPicker
                mode={entryMode}
                selected={selectedSchool}
                link={signInLink}
                linkError={linkError}
                onSelect={(value) => { setSelectedSchool(value); setLinkError(""); }}
                onLink={(value) => { setSignInLink(value); setLinkError(""); }}
                onMode={(mode) => { setEntryMode(mode); setSelectedSchool(null); setSignInLink(""); setLinkError(""); }}
                onLinkError={setLinkError}
              />
              <label className={styles.consent}>
                <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
                <span>When Canvas signs me in, the Grove extension sends this Canvas site&apos;s session cookies to Grove over an encrypted connection. I can disconnect at any time.</span>
              </label>
              {extension.status === "ready" ? (
                <div className={styles.actions}>
                  <button className="button primary" disabled={!consent || !school}>Sign in with Canvas</button>
                  {!school ? <small className={styles.helper}>Choose your school first.</small> : !consent ? <small className={styles.helper}>Confirm the statement above to continue.</small> : <small className={styles.helper}>Opens a new tab at <span className={styles.mono}>{hostOf(safeOrigin(school.domain))}</span>.</small>}
                </div>
              ) : null}
            </form>
          )}
        </>
      )}
    </section>
  );
}

function safeOrigin(value: string) {
  try { return parseInstitutionLink(value).canvasOrigin; } catch { return value; }
}

function pickSchool(mode: "search" | "link", selected: School | null, link: string): SignInSchool | null {
  if (mode === "search") return selected;
  try {
    const parsed = parseInstitutionLink(link);
    return { name: hostOf(parsed.canvasOrigin), domain: link.trim() };
  } catch { return null; }
}

// ------------------------------------------------------------------ states

function ExtensionGate({ status }: { status: ExtensionStatus }) {
  if (status === "ready") return null;
  if (status === "checking") return <p className={styles.muted} role="status">Looking for the Grove extension in this browser…</p>;
  const copy = status === "outdated"
    ? { title: "Update Grove for Canvas", body: `This browser has an older version of the extension. Canvas sign-in needs version ${MIN_EXTENSION_VERSION} or newer.`, action: "Update the extension" }
    : status === "unpaired"
      ? { title: "Connect the extension to your account", body: "Grove for Canvas is installed but not connected to this Grove account yet.", action: "Connect this browser" }
      : { title: "Install Grove for Canvas", body: "Canvas sign-in happens in this browser through the Grove extension.", action: "Set up the extension" };
  return (
    <div className={styles.notice} role="status">
      <strong>{copy.title}</strong>
      <p>{copy.body} Sign-in becomes available here once it is ready.</p>
      <AppLink className="button primary" href={EXTENSION_INSTALL_PATH}>{copy.action}</AppLink>
    </div>
  );
}

function Reconnect({ signIn, school, expired, extensionStatus, onChangeSchool }: { signIn: CanvasSignIn; school: SignInSchool; expired: boolean; extensionStatus: ExtensionStatus; onChangeSchool: () => void }) {
  return (
    <div className={styles.form}>
      <ExtensionGate status={extensionStatus} />
      <dl className={styles.facts}>
        <div><dt>School</dt><dd>{school.name}</dd></div>
        <div><dt>Canvas site</dt><dd className={styles.mono}>{hostOf(school.domain)}</dd></div>
      </dl>
      <p className={styles.body}>{expired ? "Canvas ended the saved session. Courses and deadlines Grove already synced are still here. Sign in again to resume syncing." : "A sign-in was started here but not finished."}</p>
      {extensionStatus === "ready" ? (
        <div className={styles.actions}>
          <button type="button" className="button primary" onClick={() => void signIn.retry()}>{expired ? `Sign in to ${school.name} again` : "Continue sign-in"}</button>
          <button type="button" className="button ghost" onClick={onChangeSchool}>Use a different school</button>
        </div>
      ) : null}
    </div>
  );
}

function Waiting({ signIn, schoolName }: { signIn: CanvasSignIn; schoolName: string }) {
  const host = hostOf(signIn.session?.canvasOrigin ?? "");
  const [slowFor, setSlowFor] = useState<number | null>(null);
  const startedAt = signIn.startedAt;
  useEffect(() => {
    if (startedAt === null) return;
    const remaining = Math.max(0, startedAt + SLOW_TAB_MS - Date.now());
    const id = window.setTimeout(() => setSlowFor(startedAt), remaining);
    return () => window.clearTimeout(id);
  }, [startedAt]);
  const slow = slowFor !== null && slowFor === startedAt && (signIn.phase === "awaiting-tab-click" || signIn.phase === "signing-in");

  let title: string, detail: string;
  if (signIn.phase === "starting") { title = "Opening Canvas sign-in"; detail = "Asking the Grove extension to open a new tab."; }
  else if (signIn.tabClosed) { title = "The sign-in tab was closed"; detail = `Reopen it to finish signing in to ${schoolName} Canvas. Nothing was saved yet.`; }
  else if (signIn.phase === "awaiting-tab-click" && signIn.stage === "needs-access") { title = `Allow access to ${host}`; detail = "Your browser is asking whether Grove for Canvas may read this one Canvas site. Choose Allow in the other tab."; }
  else if (signIn.phase === "awaiting-tab-click") { title = "Continue in the new tab"; detail = `Grove opened a tab next to this one. Select Continue to ${schoolName} Canvas there.`; }
  else if (signIn.phase === "signing-in") { title = `Finish signing in to ${schoolName} Canvas`; detail = "Use the tab that just opened. It closes by itself once Canvas signs you in."; }
  else { title = signIn.account ? `Signed in as ${signIn.account.name}` : "Canvas signed you in"; detail = "Grove is checking the session with Canvas before saving it."; }

  return (
    <div className={styles.waiting}>
      <div className={styles.waitingHead} role="status" aria-live="polite">
        {signIn.tabClosed ? null : <span className={styles.pulse} aria-hidden="true" />}
        <div>
          <strong>{title}</strong>
          <p>{detail}</p>
        </div>
      </div>
      {signIn.error ? <ErrorNotice error={signIn.error} /> : null}
      {signIn.phase !== "starting" && host ? <p className={styles.watch}>Watching for a signed-in page on <span className={styles.mono}>{host}</span></p> : null}
      <div className={styles.actions}>
        {signIn.tabClosed
          ? <button type="button" className="button primary" onClick={signIn.focusTab}>Reopen sign-in tab</button>
          : <button type="button" className="button secondary" onClick={signIn.focusTab} disabled={signIn.phase === "starting" || signIn.phase === "verifying"}>Show sign-in tab</button>}
        <button type="button" className="button ghost" onClick={() => void signIn.cancel()} disabled={signIn.phase === "verifying"}>Cancel</button>
      </div>
      {slow ? (
        <details className={styles.help}>
          <summary>Not seeing the tab?</summary>
          <ul>
            <li>Look for a new tab to the right of this one. Some browsers open it in the background.</li>
            <li>If the browser asked for site access and you closed the prompt, select Show sign-in tab and choose Allow.</li>
            <li>Make sure Grove for Canvas is enabled on the browser&apos;s extensions page, then cancel and try again.</li>
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function Connected({ signIn, justConnected }: { signIn: CanvasSignIn; justConnected: boolean }) {
  const existing = signIn.existing!;
  const [busy, setBusy] = useState<"verify" | "disconnect" | null>(null);
  const [checked, setChecked] = useState("");
  const [error, setError] = useState<UiError | null>(null);
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmId = useId();
  useEffect(() => { if (confirming) cancelRef.current?.focus(); }, [confirming]);

  async function verify() {
    setBusy("verify"); setError(null); setChecked("");
    try { await signIn.verify(); setChecked(`Canvas accepted the session at ${timeFormat().format(new Date())}.`); }
    catch (value) { setError(value as UiError); }
    finally { setBusy(null); }
  }
  async function disconnect() {
    setBusy("disconnect"); setError(null);
    try { await signIn.disconnect(); document.getElementById("session-title")?.focus(); }
    catch (value) { setError(value as UiError); setBusy(null); }
  }

  const host = hostOf(existing.canvasOrigin);
  return (
    <div className={styles.form}>
      {justConnected ? <p className={styles.success} role="status">{existing.accountName ? `Signed in as ${existing.accountName} on ${host}.` : `Connected to ${host}.`}</p> : null}
      <dl className={styles.facts}>
        <div><dt>Canvas site</dt><dd className={styles.mono}>{host}</dd></div>
        {existing.accountName ? <div><dt>Account</dt><dd>{existing.accountName}</dd></div> : null}
        <div><dt>Sync</dt><dd>Runs in the background, even while Grove is closed</dd></div>
      </dl>
      {error ? <ErrorNotice error={error} /> : null}
      {checked ? <p className={styles.muted} role="status">{checked}</p> : null}
      {!confirming ? (
        <div className={styles.actions}>
          <button type="button" className="button secondary" disabled={busy !== null} aria-busy={busy === "verify"} onClick={() => void verify()}>{busy === "verify" ? "Checking with Canvas…" : "Check connection"}</button>
          <button ref={triggerRef} type="button" className={`button ghost ${styles.danger}`} disabled={busy !== null} onClick={() => setConfirming(true)}>Disconnect</button>
        </div>
      ) : (
        <div className={styles.confirm} role="group" aria-labelledby={confirmId}>
          <p id={confirmId}>Disconnect Canvas? Grove deletes the saved Canvas session and stops syncing. Courses already synced stay until you remove them.</p>
          <div className={styles.actions}>
            <button type="button" className={`button secondary ${styles.danger}`} disabled={busy !== null} aria-busy={busy === "disconnect"} onClick={() => void disconnect()}>{busy === "disconnect" ? "Disconnecting…" : "Disconnect Canvas"}</button>
            <button ref={cancelRef} type="button" className="button ghost" disabled={busy !== null} onClick={() => { setConfirming(false); window.requestAnimationFrame(() => triggerRef.current?.focus()); }}>Keep connection</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ school picker

function SchoolPicker({ mode, selected, link, linkError, onSelect, onLink, onMode, onLinkError }: {
  mode: "search" | "link"; selected: School | null; link: string; linkError: string;
  onSelect: (school: School | null) => void; onLink: (value: string) => void; onMode: (mode: "search" | "link") => void; onLinkError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<School[]>([]);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [searchError, setSearchError] = useState("");
  const [active, setActive] = useState(-1);
  const timer = useRef<number>(undefined);
  const request = useRef(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => { window.clearTimeout(timer.current); abort.current?.abort(); }, []);

  function search(value: string) {
    setQuery(value); setActive(-1); setSearchError("");
    window.clearTimeout(timer.current);
    abort.current?.abort();
    const id = ++request.current;
    const q = value.replace(/\s+/g, " ").trim().slice(0, 80);
    if (q.length < 2) { setResults([]); setStatus("idle"); return; }
    setStatus("loading");
    timer.current = window.setTimeout(async () => {
      const controller = new AbortController();
      abort.current = controller;
      try {
        const response = await fetch(`/api/canvas/institutions/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        const body = await response.json().catch(() => ({})) as { results?: School[]; error?: string };
        if (id !== request.current) return;
        if (!response.ok) throw new Error(body.error || "School search is unavailable right now.");
        setResults(Array.isArray(body.results) ? body.results : []);
        setStatus("done");
      } catch (error) {
        if (id !== request.current || controller.signal.aborted) return;
        setResults([]); setStatus("error");
        setSearchError(error instanceof Error && error.message !== "Failed to fetch" ? error.message : "School search is unavailable right now. Enter your Canvas address instead.");
      }
    }, SCHOOL_SEARCH_DEBOUNCE_MS);
  }
  function choose(school: School) {
    request.current += 1;
    window.clearTimeout(timer.current);
    abort.current?.abort();
    setResults([]); setStatus("idle"); setActive(-1);
    try { parseInstitutionLink(school.domain); }
    catch { onLinkError("That school's Canvas address is not supported. Enter it below instead."); return; }
    setQuery(school.name);
    onSelect(school);
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      const target = active >= 0 ? results[active] : results.length === 1 ? results[0] : undefined;
      if (target) choose(target);
      return;
    }
    if (!results.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => (i + 1) % results.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => (i <= 0 ? results.length - 1 : i - 1)); }
    else if (event.key === "Escape") { event.preventDefault(); setResults([]); setActive(-1); setStatus("idle"); }
  }

  return (
    <div className={styles.field}>
      {mode === "search" ? selected ? (
        <div className={styles.selected}>
          <span className={styles.label} id="school-selected-label">Your school</span>
          <div className={styles.selectedRow}>
            <div>
              <strong aria-describedby="school-selected-label">{selected.name}</strong>
              <span className={styles.mono}>{selected.domain}</span>
            </div>
            <button type="button" className="button ghost" onClick={() => { onSelect(null); setQuery(""); }}>Change</button>
          </div>
        </div>
      ) : (
        <div className={styles.search}>
          <label className={styles.label} htmlFor="school-search">Your school</label>
          <input
            id="school-search" className={styles.input} type="search" role="combobox" autoComplete="off" spellCheck={false} maxLength={80}
            aria-autocomplete="list" aria-expanded={results.length > 0} aria-controls="school-search-results"
            aria-activedescendant={active >= 0 ? `school-option-${active}` : undefined}
            aria-describedby="school-search-help" aria-invalid={linkError ? true : undefined}
            value={query} onChange={(event) => search(event.target.value)} onKeyDown={onKeyDown} placeholder="Start typing your school's name"
          />
          <ul id="school-search-results" role="listbox" aria-label="Matching schools" className={styles.results} hidden={results.length === 0}>
            {results.map((school, index) => (
              <li key={`${school.domain}|${school.name}`} id={`school-option-${index}`} role="option" aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()} onClick={() => choose(school)}>
                <strong>{school.name}</strong>
                <span className={styles.mono}>{school.domain}</span>
              </li>
            ))}
          </ul>
          <small id="school-search-help" className={styles.helper}>
            {status === "loading" ? "Searching…" : status === "done" && !results.length ? "No schools matched. Try another name, or enter your Canvas address instead." : "Search by name, then choose your school from the list."}
          </small>
          {status === "error" ? <small className={styles.fieldError} role="alert">{searchError}</small> : null}
        </div>
      ) : (
        <div className={styles.search}>
          <label className={styles.label} htmlFor="canvas-sign-in-link">Canvas address or sign-in link</label>
          <input id="canvas-sign-in-link" className={`${styles.input} ${styles.monoInput}`} type="text" inputMode="url" autoComplete="url" spellCheck={false}
            value={link} aria-describedby="canvas-sign-in-link-help" aria-invalid={linkError ? true : undefined}
            onChange={(event) => onLink(event.target.value)}
            onBlur={() => { if (link.trim()) { try { parseInstitutionLink(link); } catch (error) { onLinkError(error instanceof Error ? error.message : "Enter your school's Canvas address"); } } }}
            placeholder="school.instructure.com" />
          <small id="canvas-sign-in-link-help" className={styles.helper}>The address you use for Canvas, like school.instructure.com. A single sign-on link copied from your school&apos;s Canvas login page also works.</small>
        </div>
      )}
      {linkError ? <small className={styles.fieldError} role="alert">{linkError}</small> : null}
      <p className="sr-only" role="status" aria-live="polite">
        {status === "done" ? results.length ? `${results.length} school${results.length === 1 ? "" : "s"} found. Use the up and down arrow keys to choose.` : "No schools matched." : selected ? `${selected.name} selected.` : ""}
      </p>
      <button type="button" className={styles.linkButton} onClick={() => { onMode(mode === "search" ? "link" : "search"); setQuery(""); setResults([]); setStatus("idle"); }}>
        {mode === "search" ? "Enter a Canvas address instead" : "Search for your school instead"}
      </button>
    </div>
  );
}
