"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { hostOf, type School } from "./model";
import { Mono, StepFooter, StepHeader } from "./shell";
import styles from "./orientation.module.css";

type SearchStatus = "idle" | "loading" | "done" | "error";
const SEARCH_DEBOUNCE_MS = 300;

/** Debounced `/api/canvas/institutions/search` combobox (ARIA 1.2 pattern, listbox popup). */
export function StepSchool({ school, onSelect, onBack, onNext, initialQuery = "", initialResults, initialStatus }: {
  school: School | null;
  onSelect: (school: School | null) => void;
  onBack: () => void;
  onNext: () => void;
  /** Fixture preview only. */
  initialQuery?: string; initialResults?: School[]; initialStatus?: SearchStatus;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<School[]>(initialResults ?? []);
  const [status, setStatus] = useState<SearchStatus>(initialStatus ?? "idle");
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<number>(undefined);
  const request = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const changeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => () => { window.clearTimeout(timer.current); abort.current?.abort(); }, []);

  function search(value: string) {
    setQuery(value);
    setActive(-1);
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
        const body = await response.json().catch(() => null) as { results?: School[] } | null;
        if (!response.ok) throw new Error("search failed");
        if (id !== request.current) return;
        setResults(Array.isArray(body?.results) ? body.results : []);
        setStatus("done");
      } catch {
        if (controller.signal.aborted || id !== request.current) return;
        setResults([]);
        setStatus("error");
      }
    }, SEARCH_DEBOUNCE_MS);
  }

  function choose(next: School) {
    window.clearTimeout(timer.current);
    abort.current?.abort();
    request.current += 1;
    setResults([]); setStatus("idle"); setActive(-1); setQuery(next.name);
    onSelect(next);
    window.requestAnimationFrame(() => changeButton.current?.focus());
  }

  function change() {
    onSelect(null);
    window.requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      const target = active >= 0 ? results[active] : results.length === 1 ? results[0] : undefined;
      if (target) choose(target);
      return;
    }
    if (event.key === "Escape") {
      if (results.length) { event.preventDefault(); setResults([]); setActive(-1); setStatus("idle"); }
      return;
    }
    if (!results.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => (index + 1) % results.length); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => index <= 0 ? results.length - 1 : index - 1); }
  }

  const expanded = results.length > 0;
  return <>
    <StepHeader title="Find your school">
      Grove uses your school&rsquo;s exact Canvas address, so sign-in opens on the right page.
    </StepHeader>
    {school ? <div className={styles.selected}>
      <div className={styles.selectedText}>
        <span className={styles.selectedName}>{school.name}</span>
        <Mono>{hostOf(school.domain)}</Mono>
      </div>
      <button ref={changeButton} type="button" className="button ghost" onClick={change} aria-label={`Change school (currently ${school.name})`}>Change</button>
    </div> : <div className={styles.combo}>
      <label className={styles.label} htmlFor="orientation-school">School name or Canvas address</label>
      <div className={styles.comboField}>
      <input
        ref={input}
        id="orientation-school"
        className={styles.input}
        type="search"
        value={query}
        placeholder="e.g. University of Florida"
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls="orientation-school-results"
        aria-activedescendant={active >= 0 ? `orientation-school-${active}` : undefined}
        aria-describedby="orientation-school-status"
        onChange={(event) => search(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <ul id="orientation-school-results" className={styles.results} role="listbox" aria-label="Schools" hidden={!expanded}>
        {results.map((item, index) => <li
          key={item.domain}
          id={`orientation-school-${index}`}
          role="option"
          aria-selected={index === active}
          className={styles.result}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(item)}
          onMouseEnter={() => setActive(index)}
        >
          <span className={styles.resultName}>{item.name}</span>
          <span className={styles.resultHost}>{hostOf(item.domain)}</span>
        </li>)}
      </ul>
      </div>
      <p id="orientation-school-status" className={styles.fieldHelp} data-tone={status === "error" ? "danger" : undefined} role="status" aria-live="polite">
        {status === "loading" ? "Searching schools…"
          : status === "done" && !results.length ? "No school matches that. Try its full name or its Canvas address, such as school.instructure.com."
            : status === "error" ? "School search is not responding. Check your connection and type again."
              : status === "done" ? `${results.length} ${results.length === 1 ? "school" : "schools"} found. Use the arrow keys to choose.`
                : "Type at least two letters."}
      </p>
    </div>}
    <StepFooter
      onBack={onBack}
      primary={{ label: "Continue", onClick: onNext, disabled: !school, icon: "arrow" }}
      helper={school ? undefined : "Choose your school to continue."}
    />
  </>;
}
