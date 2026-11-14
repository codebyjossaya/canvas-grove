"use client";

import { useRef, useState, type FormEvent } from "react";
import { COURSE_UPLOAD_ACCEPT, COURSE_UPLOAD_MAX_BYTES } from "@/lib/courses/upload-contracts";
import styles from "./course-file-upload.module.css";

type Folder = { id?: unknown; name?: unknown; fullName?: unknown };
export type UploadedCourseFile = { groveFileId: string; canvasFileId: string; displayName: string; filename: string; contentType: string; size: number; folderId: string | null; downloadPath: string; canvasUrl: string };

export function CourseFileUpload({ courseId, folders, onUploaded }: { courseId: string; folders: Folder[]; onUploaded(file: UploadedCourseFile): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [folderId, setFolderId] = useState("");
  const [state, setState] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const file = input.current?.files?.[0];
    if (!file) { setState("error"); setMessage("Choose a document first."); return; }
    if (file.size > COURSE_UPLOAD_MAX_BYTES) { setState("error"); setMessage("Documents must be 25 MB or smaller."); return; }
    setState("uploading"); setMessage("");
    try {
      const response = await fetch(`/api/canvas/courses/${courseId}/files/upload`, {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-grove-csrf": "1",
          "x-grove-file-name": encodeURIComponent(file.name),
          "x-grove-file-size": String(file.size),
          ...(folderId ? { "x-grove-folder-id": folderId } : {}),
          "x-idempotency-key": `course-upload:${crypto.randomUUID()}`,
        },
        body: file,
        signal: AbortSignal.timeout(120_000),
      });
      const value = await response.json() as UploadedCourseFile & { error?: string };
      if (!response.ok) throw new Error(value.error || "Canvas rejected the upload.");
      onUploaded(value);
      if (input.current) input.current.value = "";
      setState("done"); setMessage(`${value.displayName} is now in Canvas.`);
    } catch (error) {
      setState("error");
      setMessage(error instanceof DOMException && error.name === "TimeoutError" ? "The upload timed out. Check Canvas before retrying." : error instanceof Error ? error.message : "The upload could not be completed.");
    }
  }

  return <form className={styles.upload} onSubmit={submit} aria-busy={state === "uploading"}>
    <div><strong>Upload a document</strong><p>Add a document to this course&apos;s Canvas Files. This does not submit an assignment.</p></div>
    <label><span>Document</span><input ref={input} type="file" accept={COURSE_UPLOAD_ACCEPT} disabled={state === "uploading"} required /></label>
    <label><span>Destination</span><select value={folderId} onChange={event => setFolderId(event.target.value)} disabled={state === "uploading"}>
      <option value="">Course Files (root)</option>
      {folders.map((folder, index) => <option key={String(folder.id ?? index)} value={String(folder.id ?? "")}>{String(folder.fullName || folder.name || "Folder")}</option>)}
    </select></label>
    <button className="button primary" type="submit" disabled={state === "uploading"}>{state === "uploading" ? "Uploading…" : "Upload to Canvas"}</button>
    {message && <p className={state === "error" ? styles.error : styles.success} role={state === "error" ? "alert" : "status"}>{message}</p>}
    <small>PDF, text, Markdown, CSV, RTF, Word, Excel, PowerPoint, or OpenDocument · 25 MB maximum</small>
  </form>;
}
