"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Icon } from "@/components/ui/icons";
import { zonedIso, zonedParts } from "@/lib/custom-events/time";
import type { CourseRef, CustomEventItem } from "@/lib/views/types";
import styles from "./custom-event-editor.module.css";

const headers = { "content-type": "application/json", "x-grove-csrf": "1" };
const COLORS = [0, 1, 2, 3, 4, 5, 6, 7];

/** What the editor is open for: a new event on a day, or an existing one. */
export type EditorTarget = { mode: "new"; day: string } | { mode: "edit"; event: CustomEventItem };

type Form = { title: string; allDay: boolean; date: string; endDate: string; start: string; end: string; courseId: string; color: number; notes: string };

function initialForm(target: EditorTarget, zone: string): Form {
  if (target.mode === "new") return { title: "", allDay: false, date: target.day, endDate: target.day, start: "09:00", end: "10:00", courseId: "", color: 0, notes: "" };
  const event = target.event;
  if (event.allDay) return { title: event.title, allDay: true, date: event.startDate ?? "", endDate: event.endDate ?? event.startDate ?? "", start: "09:00", end: "10:00", courseId: event.course?.id ?? "", color: event.color, notes: event.notes ?? "" };
  const from = zonedParts(event.startsAt!, zone), to = zonedParts(event.endsAt!, zone);
  return { title: event.title, allDay: false, date: from.date, endDate: to.date, start: from.time, end: to.time, courseId: event.course?.id ?? "", color: event.color, notes: event.notes ?? "" };
}

/**
 * Create, edit or delete one of the student's own events. Grove-only: saved through
 * /api/custom-events and never sent to Canvas. Native <dialog> (focus trap, Esc, inert page);
 * a bottom sheet on phones.
 */
export function CustomEventEditor({ target, zone, courses, onClose }: { target: EditorTarget | null; zone: string; courses: CourseRef[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (target && !dialog.open) dialog.showModal();
    if (!target && dialog.open) dialog.close();
  }, [target]);
  return <dialog ref={ref} className={`${styles.sheet} cg-sheet`} aria-labelledby="custom-event-title" onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    {target ? <EditorBody key={target.mode === "edit" ? target.event.id : `new-${target.day}`} target={target} zone={zone} courses={courses} onClose={onClose} /> : null}
  </dialog>;
}

function EditorBody({ target, zone, courses, onClose }: { target: EditorTarget; zone: string; courses: CourseRef[]; onClose: () => void }) {
  const router = useRouter(), id = useId();
  const [form, setForm] = useState(() => initialForm(target, zone));
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const [, startTransition] = useTransition();
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm(current => ({ ...current, [key]: value }));
  const editing = target.mode === "edit";

  function body() {
    const shared = { title: form.title.trim(), notes: form.notes.trim() || null, courseId: form.courseId || null, color: form.color };
    if (form.allDay) return { ...shared, allDay: true, startDate: form.date, endDate: form.endDate < form.date ? form.date : form.endDate };
    const startsAt = zonedIso(form.date, form.start, zone), endsAt = zonedIso(form.date, form.end, zone);
    if (!startsAt || !endsAt) return null;
    return { ...shared, allDay: false, startsAt, endsAt };
  }

  async function send(method: "POST" | "PUT" | "DELETE", payload?: unknown) {
    const url = target.mode === "edit" ? `/api/custom-events/${target.event.id}` : "/api/custom-events";
    const response = await fetch(url, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload), cache: "no-store" }).catch(() => null);
    if (response?.ok) { startTransition(() => router.refresh()); onClose(); return; }
    const data = await response?.json().catch(() => null) as { error?: string } | null;
    setError(data?.error ?? "Could not reach Grove. Try again.");
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const payload = body();
    if (!payload) { setError("Pick a date and times."); return; }
    if ("startsAt" in payload && Date.parse(payload.endsAt) < Date.parse(payload.startsAt)) { setError("The event ends before it starts."); return; }
    setBusy("save"); setError("");
    await send(editing ? "PUT" : "POST", payload);
    setBusy(null);
  }

  async function remove() {
    if (busy) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setBusy("delete"); setError("");
    await send("DELETE");
    setBusy(null);
  }

  return <form className={styles.inner} onSubmit={save}>
    <header className={styles.head}>
      <h2 id="custom-event-title">{editing ? "Edit event" : "New event"}</h2>
      <span className={`chip ${styles.badge}`}>Custom</span>
      <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
    </header>
    <div className={styles.body}>
      <p className={styles.hint}>Only in Grove. Custom events never sync to Canvas.</p>
      <label className={styles.field} htmlFor={`${id}-title`}>Title<input id={`${id}-title`} value={form.title} maxLength={200} required autoComplete="off" autoFocus={!editing} onChange={event => set("title", event.target.value)} /></label>
      <label className={styles.check}><input type="checkbox" checked={form.allDay} onChange={event => set("allDay", event.target.checked)} />All day</label>
      <div className={styles.row}>
        <label className={styles.field} htmlFor={`${id}-date`}>{form.allDay ? "Starts" : "Date"}<input id={`${id}-date`} type="date" value={form.date} required onChange={event => set("date", event.target.value)} /></label>
        {form.allDay
          ? <label className={styles.field} htmlFor={`${id}-end-date`}>Ends<input id={`${id}-end-date`} type="date" value={form.endDate} min={form.date} required onChange={event => set("endDate", event.target.value)} /></label>
          : <>
            <label className={styles.field} htmlFor={`${id}-start`}>From<input id={`${id}-start`} type="time" value={form.start} required onChange={event => set("start", event.target.value)} /></label>
            <label className={styles.field} htmlFor={`${id}-end`}>To<input id={`${id}-end`} type="time" value={form.end} required onChange={event => set("end", event.target.value)} /></label>
          </>}
      </div>
      <label className={styles.field} htmlFor={`${id}-course`}>Course<select id={`${id}-course`} value={form.courseId} onChange={event => set("courseId", event.target.value)}>
        <option value="">None</option>
        {courses.map(course => <option key={course.id} value={course.id}>{course.code} · {course.name}</option>)}
      </select></label>
      <fieldset className={styles.colors}>
        <legend>Color</legend>
        {COLORS.map(color => <label key={color} className={`c${color}`} title={`Color ${color + 1}`}>
          <input type="radio" name={`${id}-color`} value={color} checked={form.color === color} onChange={() => set("color", color)} />
          <span className="sr-only">Color {color + 1}</span>
        </label>)}
      </fieldset>
      <label className={styles.field} htmlFor={`${id}-notes`}>Notes<textarea id={`${id}-notes`} rows={3} maxLength={2000} value={form.notes} onChange={event => set("notes", event.target.value)} /></label>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </div>
    <footer className={styles.foot}>
      {editing ? <button type="button" className={`button ghost ${styles.delete}`} disabled={busy !== null} onClick={remove}>{busy === "delete" ? "Deleting…" : confirmDelete ? "Confirm delete" : "Delete"}</button> : null}
      <span className={styles.spacer} />
      <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
      <button type="submit" className="button primary" disabled={busy !== null || !form.title.trim()}>{busy === "save" ? "Saving…" : "Save"}</button>
    </footer>
  </form>;
}
