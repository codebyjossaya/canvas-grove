"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { beginFavoriteChange, finishFavoriteChange } from "@/lib/courses/favorites";
import { Icon } from "./icons";

export function CourseFavoriteToggle({ courseId, initialActive, compact = false }: { courseId: string; initialActive: boolean; compact?: boolean }) {
  const router = useRouter();
  const [active, setActive] = useState(initialActive);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function toggle() {
    if (busy) return;
    const next = !active;
    const optimistic = beginFavoriteChange(active, next);
    setActive(next); setBusy(true); setError("");
    try {
      const response = await fetch(`/api/canvas/courses/${courseId}/favorite`, {
        method: "POST", headers: { "content-type": "application/json", "x-idempotency-key": `course-favorite:${courseId}:${crypto.randomUUID()}` }, body: JSON.stringify({ active: next }),
      });
      const value = await response.json().catch(() => ({})) as { course?: { active?: boolean }; error?: string };
      if (!response.ok || typeof value.course?.active !== "boolean") throw new Error(value.error || "Canvas could not update this course.");
      setActive(finishFavoriteChange(optimistic, { ok: true, active: value.course.active }));
      router.refresh();
    } catch (value) {
      setActive(finishFavoriteChange(optimistic, { ok: false }));
      setError(value instanceof Error ? value.message : "Canvas could not update this course.");
    } finally { setBusy(false); }
  }
  return <div className={`favorite-control ${compact ? "compact" : ""}`} onClick={(event) => event.preventDefault()}>
    <button type="button" role="switch" aria-checked={active} aria-label={active ? "Active course. Mark inactive" : "Inactive course. Mark active"} title={active ? "Active in Canvas (favorite). Click to mark inactive" : "Mark active (favorite in Canvas)"} disabled={busy} aria-busy={busy} onClick={() => void toggle()}><Icon name="star" />{compact ? null : busy ? "Saving…" : active ? "Active" : "Inactive"}</button>
    {error && <small role="alert">{error}</small>}
  </div>;
}
