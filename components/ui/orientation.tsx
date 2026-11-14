"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { EXTENSION_INSTALL_PATH } from "@/lib/extension/links";
import { ErrorNotice } from "./error-notice";
import { GroveMark, Icon } from "./icons";
import { toUiError, type UiError } from "./ui-errors";

export const ORIENTATION_STEPS = [
  { eyebrow: "Welcome", icon: "today", title: "A calmer view of Canvas.", body: "Canvas Grove gathers your courses, deadlines, and messages into one focused workspace. It complements Canvas; your school remains the source of truth.", note: "See what matters now, without hunting through tabs." },
  { eyebrow: "Your school", icon: "search", title: "First, find your school.", body: "Choose the school whose Canvas account you want to connect. Grove uses its exact Canvas origin for the extension handoff, so you land on the right sign-in page.", note: "Your school choice stays with this setup and can be changed later in Settings." },
  { eyebrow: "Browser extension", icon: "external", title: "Canvas sign-in stays on your device.", body: "Install and pair the Grove for Canvas browser extension before connecting Canvas. Grove opens your school's real Canvas page in this browser, where you sign in normally and complete multi-factor authentication.", note: "The extension is required. Download the latest release, unzip it, and load the folder in Chrome or Edge.", installHref: EXTENSION_INSTALL_PATH },
  { eyebrow: "Privacy", icon: "lock", title: "Approve one Canvas site, not your whole browser.", body: "The extension reads cookies only for the exact Canvas origin you chose. It does not collect your institution password, identity-provider cookies, Grove password, or data from unrelated sites.", note: "Grove waits for Canvas to recognize you before it sends the scoped session to Grove for verification." },
  { eyebrow: "Connect", icon: "wifi", title: "Finish sign-in, then Grove takes it from there.", body: "The extension opens a dedicated Canvas popup and keeps it open while you sign in. As soon as Canvas recognizes you, Grove verifies the session and immediately closes that popup after confirmation.", note: "If Canvas shows the wrong account, switch accounts in the popup before sign-in completes." },
  { eyebrow: "Ready", icon: "check-circle", title: "Make the grove yours.", body: "Connect Canvas and begin syncing. Scheduled sync can refresh supported Canvas information in the background, and Settings always shows freshness, errors, and controls to revoke the browser or Canvas session.", note: "Canvas remains the source of truth, and availability can affect sync timing." },
] as const;

type StepDirection = "forward" | "backward";
type School = { name: string; domain: string };
type SchoolSearchStatus = "idle" | "loading" | "done" | "error";
const SCHOOL_SEARCH_DEBOUNCE_MS = 300;

export function Orientation() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<StepDirection>("forward");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [schoolQuery, setSchoolQuery] = useState("");
  const [schoolResults, setSchoolResults] = useState<School[]>([]);
  const [selectedSchool, setSelectedSchool] = useState<School | null>(null);
  const [schoolStatus, setSchoolStatus] = useState<SchoolSearchStatus>("idle");
  const [schoolError, setSchoolError] = useState("");
  const [activeSchool, setActiveSchool] = useState(-1);
  const heading = useRef<HTMLHeadingElement>(null);
  const progressButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const schoolSearchTimer = useRef<number>(undefined);
  const schoolSearchRequest = useRef(0);
  const schoolSearchAbort = useRef<AbortController | null>(null);
  const item = ORIENTATION_STEPS[step];
  const last = step === ORIENTATION_STEPS.length - 1;

  useEffect(() => heading.current?.focus({ preventScroll: true }), [step]);
  useEffect(() => () => {
    if (schoolSearchTimer.current) clearTimeout(schoolSearchTimer.current);
    schoolSearchAbort.current?.abort();
  }, []);

  function goTo(next: number) {
    let bounded = Math.max(0, Math.min(ORIENTATION_STEPS.length - 1, next));
    if (bounded > 1 && !selectedSchool) bounded = 1;
    if (bounded === step) return;
    setDirection(bounded > step ? "forward" : "backward");
    setStep(bounded);
    setError(null);
  }

  function onProgressKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = Math.min(index + 1, ORIENTATION_STEPS.length - 1);
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = Math.max(index - 1, 0);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = selectedSchool ? ORIENTATION_STEPS.length - 1 : 1;
    if (next === null) return;
    event.preventDefault();
    progressButtons.current[next]?.focus();
  }

  function changeSchoolQuery(value: string) {
    setSchoolQuery(value);
    setSelectedSchool(null);
    setActiveSchool(-1);
    setSchoolError("");
    if (schoolSearchTimer.current) clearTimeout(schoolSearchTimer.current);
    schoolSearchAbort.current?.abort();
    const request = ++schoolSearchRequest.current;
    const query = value.replace(/\s+/g, " ").trim().slice(0, 80);
    if (query.length < 2) {
      setSchoolResults([]);
      setSchoolStatus("idle");
      return;
    }
    setSchoolStatus("loading");
    schoolSearchTimer.current = window.setTimeout(async () => {
      const controller = new AbortController();
      schoolSearchAbort.current = controller;
      try {
        const response = await fetch(`/api/canvas/institutions/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        const result = await response.json().catch(() => null) as { results?: School[]; error?: string } | null;
        if (!response.ok) throw new Error(result?.error || "School search failed");
        if (request !== schoolSearchRequest.current) return;
        setSchoolResults(Array.isArray(result?.results) ? result.results : []);
        setSchoolStatus("done");
      } catch (caught) {
        if (controller.signal.aborted || request !== schoolSearchRequest.current) return;
        setSchoolResults([]);
        setSchoolStatus("error");
        setSchoolError(caught instanceof Error ? caught.message : "School search failed");
      }
    }, SCHOOL_SEARCH_DEBOUNCE_MS);
  }

  function selectSchool(school: School) {
    if (schoolSearchTimer.current) clearTimeout(schoolSearchTimer.current);
    schoolSearchAbort.current?.abort();
    schoolSearchRequest.current += 1;
    setSelectedSchool(school);
    setSchoolQuery(school.name);
    setSchoolResults([]);
    setSchoolStatus("idle");
    setSchoolError("");
    setActiveSchool(-1);
  }

  function onSchoolKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      const target = activeSchool >= 0 ? schoolResults[activeSchool] : schoolResults.length === 1 ? schoolResults[0] : undefined;
      if (target) selectSchool(target);
      return;
    }
    if (!schoolResults.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSchool((index) => (index + 1) % schoolResults.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSchool((index) => index <= 0 ? schoolResults.length - 1 : index - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setSchoolResults([]);
      setActiveSchool(-1);
      setSchoolStatus("idle");
    }
  }

  function settingsDestination() {
    if (!selectedSchool) return "/settings#connection";
    const params = new URLSearchParams({ canvasSchoolName: selectedSchool.name, canvasSchoolDomain: selectedSchool.domain });
    return `/settings?${params.toString()}#connection`;
  }

  async function finish(destination: string) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ completed: true }) });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error || "Your orientation choice could not be saved.");
      }
      router.push(destination);
      router.refresh();
    } catch (caught) {
      setError(toUiError(caught, !navigator.onLine ? "NETWORK_OFFLINE" : "SERVER_UNAVAILABLE"));
      setSaving(false);
    }
  }

  return <main className="orientation">
    <header className="orientation-bar">
      <Link className="brand" href="/"><GroveMark /><span>Canvas Grove</span></Link>
      <button type="button" className="orientation-skip" disabled={saving} onClick={() => void finish("/")}>Skip for now</button>
    </header>
    <section className="orientation-frame" aria-labelledby="orientation-title">
      <aside key={`visual-${step}`} className="orientation-visual" data-direction={direction}>
        <div className="orientation-visual-head">
          <span className="orientation-number" aria-hidden="true">{String(step + 1).padStart(2, "0")}</span>
          <span className="orientation-step-icon" aria-hidden="true"><Icon name={item.icon} /></span>
        </div>
        <div className="orientation-orbit" aria-hidden="true"><i /><i /><i /><span><GroveMark /></span></div>
        <div className="orientation-note">
          <span className="orientation-note-kicker">Good to know</span>
          <p>{item.note}</p>
        </div>
      </aside>
      <div className="orientation-copy">
        <nav className="orientation-progress" aria-label="Orientation steps">
          <div className="orientation-progress-label"><span>Orientation</span><strong aria-live="polite">{step + 1} <i aria-hidden="true">/</i> {ORIENTATION_STEPS.length}</strong></div>
          <ol>{ORIENTATION_STEPS.map((entry, index) => <li key={entry.eyebrow}>
            <button
              ref={(node) => { progressButtons.current[index] = node; }}
              type="button"
              className={index < step ? "complete" : ""}
              tabIndex={index === step ? 0 : -1}
              aria-current={index === step ? "step" : undefined}
              aria-label={`${index < step ? "Completed" : index === step ? "Current" : "Go to"} step ${index + 1}: ${entry.eyebrow}`}
              disabled={saving || (index > 1 && !selectedSchool)}
              onClick={() => goTo(index)}
              onKeyDown={(event) => onProgressKeyDown(event, index)}
            ><span aria-hidden="true">{index < step ? <Icon name="check" /> : index + 1}</span><em>{entry.eyebrow}</em></button>
          </li>)}</ol>
        </nav>
        <div key={`copy-${step}`} className="orientation-step" data-direction={direction}>
          <p className="eyebrow">{item.eyebrow}</p>
          <h1 id="orientation-title" ref={heading} tabIndex={-1}>{item.title}</h1>
          <p className="orientation-body">{item.body}</p>
          {item.eyebrow === "Your school" && <div className="orientation-school">
            {selectedSchool ? <div className="school-selected" role="status">
              <span>Selected school</span>
              <strong>{selectedSchool.name}</strong>
              <span className="school-domain">{selectedSchool.domain}</span>
              <button type="button" className="link-button" onClick={() => changeSchoolQuery("")}>Change school</button>
            </div> : <div className="school-search">
              <label htmlFor="orientation-school-search">School name</label>
              <input
                id="orientation-school-search"
                type="search"
                value={schoolQuery}
                placeholder="Search for your school"
                autoComplete="organization"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={schoolResults.length > 0}
                aria-controls="orientation-school-results"
                aria-activedescendant={activeSchool >= 0 ? `orientation-school-${activeSchool}` : undefined}
                onChange={(event) => changeSchoolQuery(event.target.value)}
                onKeyDown={onSchoolKeyDown}
              />
              <span className="orientation-school-status" role="status" aria-live="polite">
                {schoolStatus === "loading" ? "Searching schools…" : schoolStatus === "done" && !schoolResults.length ? "No schools found. Try the school name or Canvas domain." : ""}
              </span>
              {schoolError && <span className="orientation-school-error" role="alert">{schoolError}</span>}
              <ul id="orientation-school-results" className="school-results" role="listbox" hidden={!schoolResults.length}>
                {schoolResults.map((school, index) => <li key={school.domain} id={`orientation-school-${index}`} role="option" aria-selected={index === activeSchool}>
                  <button type="button" onClick={() => selectSchool(school)} onMouseEnter={() => setActiveSchool(index)}>
                    <strong>{school.name}</strong><span className="school-domain">{school.domain}</span>
                  </button>
                </li>)}
              </ul>
            </div>}
          </div>}
          {"installHref" in item && <Link className="orientation-inline-link" href={item.installHref} target="_blank" rel="noopener noreferrer"><span>Install or connect the extension</span><Icon name="arrow" /></Link>}
        </div>
        {error && <ErrorNotice error={error} onRetry={() => void finish(last ? settingsDestination() : "/")} />}
        <div className="orientation-actions">
          <button type="button" className="button secondary large" disabled={step === 0 || saving} onClick={() => goTo(step - 1)}><Icon name="arrow-left" />Back</button>
          {!last
            ? <button type="button" className="button primary large" disabled={saving || (step === 1 && !selectedSchool)} onClick={() => goTo(step + 1)}>Continue <Icon name="arrow" /></button>
            : <div className="orientation-finish"><button type="button" className="button primary large" disabled={saving} aria-busy={saving} onClick={() => void finish(settingsDestination())}>{saving ? "Saving..." : "Connect Canvas"}</button><button type="button" className="button ghost large" disabled={saving} onClick={() => void finish("/")}>Enter dashboard</button></div>}
        </div>
      </div>
    </section>
  </main>;
}
