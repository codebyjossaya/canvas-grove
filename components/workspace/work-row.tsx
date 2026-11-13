import { AppLink } from "@/components/ui/app-link";
import { Icon } from "@/components/ui/icons";
import { dueLabel, relativeDue, timeLabel } from "@/lib/views/dates";
import type { WorkItem, WorkKind, WorkState } from "@/lib/views/types";
import styles from "./work.module.css";
import { NAV_FORWARD } from "@/components/ui/page-transition";

const kindIcon: Partial<Record<WorkKind, string>> = { quiz: "quiz", discussion: "discussion", event: "event", note: "note", page: "page" };
const kindLabel: Record<WorkKind, string> = { assignment: "Assignment", quiz: "Quiz", discussion: "Discussion", event: "Event", note: "Planner note", page: "Reading", other: "Item" };

export function stateChip(item: Pick<WorkItem, "state" | "score" | "points">): { label: string; tone: string } | null {
  switch (item.state) {
    case "missing": return { label: "Missing", tone: "danger" };
    case "late": return { label: "Submitted late", tone: "warning" };
    case "submitted": return { label: "Submitted", tone: "success" };
    case "graded": return { label: item.score != null && item.points != null ? `${fmt(item.score)}/${fmt(item.points)}` : "Graded", tone: "success" };
    case "excused": return { label: "Excused", tone: "" };
    case "done": return { label: "Done", tone: "success" };
    default: return null;
  }
}

function fmt(value: number) { return Number.isInteger(value) ? String(value) : value.toFixed(1); }

function StatusGlyph({ state }: { state: WorkState }) {
  if (state === "submitted" || state === "graded" || state === "done" || state === "late") return <span className={`${styles.glyph} ${styles.done}`}><Icon name="check-circle" /></span>;
  if (state === "overdue" || state === "missing") return <span className={`${styles.glyph} ${styles.alert}`}><Icon name="alert" /></span>;
  if (state === "excused" || state === "past") return <span className={`${styles.glyph} ${styles.muted}`}><Icon name="circle-dash" /></span>;
  return <span className={styles.glyph}><Icon name="circle" /></span>;
}

/**
 * One row of work. `when` controls the time column: "time" for rows already grouped by day,
 * "relative" for overdue rows, "date" for ungrouped lists.
 */
export function WorkRow({ item, now, zone, when = "time", showCourse = true }: { item: WorkItem; now: string; zone: string; when?: "time" | "relative" | "date"; showCourse?: boolean }) {
  const chip = stateChip(item);
  const finished = item.state === "submitted" || item.state === "graded" || item.state === "done" || item.state === "excused" || item.state === "late" || item.state === "past";
  const timeText = !item.dueAt ? "No date" : when === "relative" ? relativeDue(item.dueAt, now) : when === "date" ? dueLabel(item.dueAt, zone, now) : timeLabel(item.dueAt, zone);
  const icon = kindIcon[item.kind];
  return <li className={`${styles.row} ${finished ? styles.finished : ""} ${item.course ? `c${item.course.color}` : ""}`}>
    <StatusGlyph state={item.state} />
    <div className={styles.main}>
      {item.href ? <AppLink className={styles.title} href={item.href} transitionTypes={NAV_FORWARD}>{item.title}</AppLink> : <span className={styles.title}>{item.title}</span>}
      <span className={styles.meta}>
        {showCourse && item.course && <span className="course-code" title={item.course.name}>{item.course.code}</span>}
        {icon && <span className={styles.kind}><Icon name={icon} />{kindLabel[item.kind]}</span>}
        {chip && <span className={`chip ${chip.tone}`}>{chip.label}</span>}
      </span>
    </div>
    <span className={styles.points}>{item.points != null && item.points > 0 ? <>{fmt(item.points)}<small> pts</small></> : null}</span>
    <time className={`${styles.time} ${when === "relative" ? styles.late : ""}`} dateTime={item.dueAt ?? undefined}>{timeText}</time>
    <span className={styles.actions}>{item.canvasUrl ? <a href={item.canvasUrl} target="_blank" rel="noopener noreferrer" className={styles.action} aria-label={`Open ${item.title} in Canvas`} title="Open in Canvas"><Icon name="external" /></a> : null}</span>
  </li>;
}

export function WorkList({ items, now, zone, when, showCourse, label }: { items: WorkItem[]; now: string; zone: string; when?: "time" | "relative" | "date"; showCourse?: boolean; label?: string }) {
  return <ul className={styles.list} aria-label={label}>{items.map(item => <WorkRow key={item.id} item={item} now={now} zone={zone} when={when} showCourse={showCourse} />)}</ul>;
}
