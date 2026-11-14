"use client";

import { useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { COURSE_UPLOAD_ACCEPT, COURSE_UPLOAD_MAX_BYTES } from "@/lib/courses/upload-contracts";
import styles from "./assignment-document-submission.module.css";

type LivePreview = { assignmentTitle: string; courseName: string; previousAttempt: number; nextAttempt: number; allowedAttempts: number | null };
type Props = { assignmentId: string; assignmentTitle: string; courseName: string; submitted: boolean; advisory: string | null };
const sizeLabel = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

export function AssignmentDocumentSubmission({ assignmentId, assignmentTitle, courseName, submitted, advisory }: Props) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const key = useRef<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<LivePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [receipt, setReceipt] = useState<{ attempt: number | null; filename: string } | null>(null);

  async function selected(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0] ?? null;
    key.current = null; setFile(chosen); setPreview(null); setConfirmed(false); setError(null); setUncertain(false); setReceipt(null);
    if (!chosen) return;
    if (chosen.size < 1 || chosen.size > COURSE_UPLOAD_MAX_BYTES) { setError("Choose a non-empty document no larger than 25 MB."); return; }
    setChecking(true);
    try {
      const response = await fetch(`/api/canvas/assignments/${encodeURIComponent(assignmentId)}/document`, { cache: "no-store", headers: { "x-grove-csrf": "1" } });
      const value = await response.json() as LivePreview & { error?: string };
      if (!response.ok) throw new Error(value.error || "Canvas is not allowing a document submission right now.");
      setPreview(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Grove could not verify the assignment."); }
    finally { setChecking(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || !preview || !confirmed || pending) return;
    setPending(true); setError(null); setUncertain(false);
    key.current ??= `assignment-document:${crypto.randomUUID()}`;
    let structured = false;
    try {
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), value => value.toString(16).padStart(2, "0")).join("");
      const response = await fetch(`/api/canvas/assignments/${encodeURIComponent(assignmentId)}/document`, {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(180_000),
        headers: { "content-type": file.type || "application/octet-stream", "x-grove-csrf": "1", "x-grove-file-name": encodeURIComponent(file.name), "x-grove-file-size": String(file.size), "x-grove-file-sha256": digest, "x-idempotency-key": key.current },
        body: file,
      });
      const value = await response.json() as { error?: string; code?: string; attempt?: number | null; filename?: string };
      if (!response.ok) {
        structured = true;
        const unknown = ["SUBMISSION_STATUS_UNKNOWN", "SUBMISSION_UNCONFIRMED", "DOCUMENT_SUBMISSION_STATUS_UNKNOWN", "FILE_DIGEST_MISMATCH_STATUS_UNKNOWN", "CANVAS_UPLOAD_UNCONFIRMED", "CANVAS_UPLOAD_STATUS_UNKNOWN", "ASSIGNMENT_SUBMISSION_FAILED"].includes(value.code ?? "");
        setUncertain(unknown); if (!unknown) key.current = null;
        throw new Error(value.error || "Canvas did not accept this document submission.");
      }
      setReceipt({ attempt: value.attempt ?? null, filename: value.filename ?? file.name });
      setConfirmed(false); setUncertain(false); key.current = null; if (input.current) input.current.value = ""; setFile(null); setPreview(null); router.refresh();
    } catch (cause) {
      if (!structured) setUncertain(true);
      setError(cause instanceof DOMException && cause.name === "TimeoutError" ? "The request timed out. Check this assignment in Canvas before retrying." : cause instanceof Error ? cause.message : "Grove could not confirm this submission. Check Canvas before retrying.");
    } finally { setPending(false); }
  }

  return <section className={styles.card} aria-labelledby="assignment-document-submit">
    <div><h2 id="assignment-document-submit">{submitted ? "Submit another document attempt" : "Submit a document"}</h2><p className={styles.intro}>Upload a document and turn it in to this exact Canvas assignment.</p></div>
    {advisory && <p className={styles.warning}>{advisory} Canvas rules will be checked again before upload and again before submission.</p>}
    <form className={styles.form} onSubmit={submit} aria-busy={pending || checking}>
      <label>Document<input ref={input} type="file" accept={COURSE_UPLOAD_ACCEPT} onChange={selected} disabled={pending} required /></label>
      {checking && <p className={styles.hint}>Checking the live assignment rules…</p>}
      {file && preview && <dl className={styles.preview}>
        <div><dt>Course</dt><dd>{preview.courseName || courseName}</dd></div><div><dt>Assignment</dt><dd>{preview.assignmentTitle || assignmentTitle}</dd></div>
        <div><dt>Document</dt><dd>{file.name}</dd></div><div><dt>Type</dt><dd>{file.type || "Detected from filename"}</dd></div>
        <div><dt>Size</dt><dd>{sizeLabel(file.size)}</dd></div><div><dt>Attempt</dt><dd>{preview.nextAttempt}{preview.allowedAttempts != null ? ` of ${preview.allowedAttempts}` : ""}</dd></div>
      </dl>}
      {file && preview && <label className={styles.confirm}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={pending} /><span>I reviewed the course, assignment, document, and attempt. Submit this file to Canvas.</span></label>}
      <div className={styles.actions}><button className="button primary" type="submit" disabled={!file || !preview || !confirmed || pending}>{pending ? "Uploading and submitting…" : "Submit document to Canvas"}</button><span className={styles.hint}>This counts as an assignment attempt.</span></div>
    </form>
    <div aria-live="polite">{error && <p className={styles.error}>{error}</p>}{uncertain && <button className="button secondary" type="button" onClick={() => { key.current = null; setUncertain(false); setError(null); }}>I checked Canvas; it was not submitted — allow a new attempt</button>}{receipt && <p className={styles.success}>{receipt.filename} was submitted to Canvas{receipt.attempt ? ` as attempt ${receipt.attempt}` : ""}.</p>}</div>
  </section>;
}
