"use client";

import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { AssignmentSubmissionType } from "@/lib/assignments/contracts";
import styles from "./assignment-detail.module.css";

type Props = {
  assignmentId: string;
  submissionTypes: string[];
  submitted: boolean;
  advisory: string | null;
  canvasUrl: string | null;
};

const LABELS: Record<AssignmentSubmissionType, string> = { online_text_entry: "Text entry", online_url: "Website URL", online_upload: "File upload" };

export function AssignmentSubmissionForm({ assignmentId, submissionTypes, submitted, advisory, canvasUrl }: Props) {
  const router = useRouter();
  const available = submissionTypes.filter((type): type is AssignmentSubmissionType => type === "online_text_entry" || type === "online_url");
  const [type, setType] = useState<AssignmentSubmissionType>(available[0] ?? "online_text_entry");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [receipt, setReceipt] = useState<{ attempt: number | null; submittedAt: string | null } | null>(null);
  const key = useRef<string | null>(null);

  const changed = () => { key.current = null; setError(null); setUncertain(false); setReceipt(null); };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || pending) return;
    setPending(true); setError(null);
    key.current ??= `assignment:${crypto.randomUUID()}`;
    const payload = type === "online_text_entry" ? { type, body } : { type, url };
    let structuredFailure = false;
    try {
      const response = await fetch(`/api/canvas/assignments/${encodeURIComponent(assignmentId)}/submit`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json", "x-grove-csrf": "1", "x-idempotency-key": key.current },
        body: JSON.stringify(payload),
      });
      const result = await response.json() as { error?: string; code?: string; attempt?: number | null; submittedAt?: string | null };
      if (!response.ok) {
        structuredFailure = true;
        // A normal Canvas rejection is terminal for this operation and may be retried later with a
        // new key. An uncertain network outcome keeps its key so a later replay cannot duplicate it.
        const outcomeUncertain = ["SUBMISSION_STATUS_UNKNOWN", "SUBMISSION_UNCONFIRMED", "CANVAS_SUBMISSION_FAILED", "ASSIGNMENT_SUBMISSION_FAILED"].includes(result.code ?? "");
        if (!outcomeUncertain) key.current = null;
        setUncertain(outcomeUncertain);
        throw new Error(result.error || "Canvas did not accept this submission.");
      }
      setReceipt({ attempt: result.attempt ?? null, submittedAt: result.submittedAt ?? null });
      setConfirmed(false); setUncertain(false); key.current = null; router.refresh();
    } catch (cause) {
      if (!structuredFailure) setUncertain(true);
      setError(cause instanceof Error ? cause.message : "Grove could not confirm this assignment submission. Check Canvas before trying again.");
    }
    finally { setPending(false); }
  }

  if (!available.length) {
    if (!submissionTypes.includes("online_upload")) return null;
    return <section className={styles.submitCard} aria-labelledby="assignment-submit">
      <h2 id="assignment-submit">Submit assignment</h2>
      <p className={styles.submitNote}>This assignment requires a file upload. Upload it in Canvas so Canvas can apply its file type and size rules.</p>
      {canvasUrl && <a className="button primary" href={canvasUrl} target="_blank" rel="noopener noreferrer">Upload in Canvas</a>}
    </section>;
  }

  return <section className={styles.submitCard} aria-labelledby="assignment-submit">
    <h2 id="assignment-submit">{submitted ? "Submit another attempt" : "Submit assignment"}</h2>
    {advisory && <p className={styles.submitWarning}>{advisory} Grove will check the current Canvas rules again when you submit.</p>}
    {submissionTypes.includes("online_upload") && canvasUrl && <p className={styles.submitNote}>Need to upload a file? <a href={canvasUrl} target="_blank" rel="noopener noreferrer">Use Canvas for the file submission.</a></p>}
    <form className={styles.submitForm} onSubmit={submit}>
        {available.length > 1 && <label>Submission type<select value={type} onChange={(event) => { setType(event.target.value as AssignmentSubmissionType); changed(); }}>{available.map((item) => <option key={item} value={item}>{LABELS[item]}</option>)}</select></label>}
        {type === "online_text_entry"
          ? <label>Your response<textarea value={body} onChange={(event) => { setBody(event.target.value); changed(); }} rows={9} maxLength={50_000} required disabled={pending} /></label>
          : <label>Website URL<input value={url} onChange={(event) => { setUrl(event.target.value); changed(); }} type="url" inputMode="url" maxLength={2_000} placeholder="https://" required disabled={pending} /></label>}
        <label className={styles.confirm}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={pending} />
          <span>I reviewed this submission and understand Canvas may count it as an attempt.</span></label>
        <div className={styles.submitActions}><button className="button primary" type="submit" disabled={!confirmed || pending}>{pending ? "Submitting…" : submitted ? "Submit another attempt" : "Submit to Canvas"}</button>
          <span className={styles.finalWarning}>Submission is sent directly to Canvas.</span></div>
    </form>
    <div className={styles.submitResult} aria-live="polite">{error && <p className={styles.submitError}>{error}</p>}{uncertain && <button className="button secondary" type="button" onClick={() => { key.current = null; setUncertain(false); setError(null); }}>I checked Canvas; it was not submitted — allow a new attempt</button>}{receipt && <p className={styles.submitSuccess}>Submitted to Canvas{receipt.attempt ? ` as attempt ${receipt.attempt}` : ""}.</p>}</div>
  </section>;
}
