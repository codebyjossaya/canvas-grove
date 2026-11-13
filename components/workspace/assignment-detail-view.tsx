"use client";

import { AppLink } from "@/components/ui/app-link";
import { CanvasProse } from "@/components/ui/canvas-prose";
import { Icon } from "@/components/ui/icons";
import { useDisplayTimeZone } from "@/components/ui/use-display-timezone";
import { formatInstant } from "@/lib/time";
import type { AssignmentDetail } from "@/lib/views/assignment-detail";
import styles from "./assignment-detail.module.css";
import { NAV_BACK } from "@/components/ui/page-transition";

const when = (value: string | null, zone: string) => value ? formatInstant(value, zone, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : null;
const TYPE_LABELS: Record<string, string> = { online_upload: "File upload", online_text_entry: "Text entry", online_url: "Website URL", online_quiz: "Quiz", external_tool: "External tool", media_recording: "Media recording", discussion_topic: "Discussion", on_paper: "On paper", none: "No submission", student_annotation: "Annotation" };
const typeLabel = (value: string) => TYPE_LABELS[value] ?? value.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());

export function AssignmentDetailView({ detail }: { detail: AssignmentDetail }) {
  const zone = useDisplayTimeZone();
  const facts: Array<[string, string | null]> = [
    ["Due", when(detail.dueAt, zone)],
    ["Available from", when(detail.unlockAt, zone)],
    ["Locks", when(detail.lockAt, zone)],
    ["Points", detail.points != null ? String(detail.points) : null],
    ["Submission", detail.submissionTypes.length ? detail.submissionTypes.filter(type => type !== "none").map(typeLabel).join(", ") || "No submission" : null],
  ];
  const shown = facts.filter((fact): fact is [string, string] => Boolean(fact[1]));
  const tone = detail.submitted ? styles.done : detail.status === "Missing" ? styles.missing : styles.pending;
  return <main className={`page ${styles.page}`}>
    <nav className={styles.crumbs} aria-label="Breadcrumb">
      <AppLink href="/courses" transitionTypes={NAV_BACK}>Courses</AppLink><Icon name="chevron-right" />
      <AppLink href={`/courses/${detail.courseId}`} transitionTypes={NAV_BACK}>{detail.courseCode || detail.courseName}</AppLink><Icon name="chevron-right" />
      <AppLink href={`/courses/${detail.courseId}/assignments`} transitionTypes={NAV_BACK}>Assignments</AppLink>
    </nav>
    <header className={styles.head}>
      <div>
        <p className={styles.course}>{detail.courseName}</p>
        <h1>{detail.title}</h1>
        {detail.status && <p className={`${styles.status} ${tone}`}><span aria-hidden="true" />{detail.status}</p>}
      </div>
      <div className={styles.actions}>
        {detail.quizHref && <AppLink className="button primary" href={detail.quizHref}>Open quiz</AppLink>}
        {detail.canvasUrl && <a className={`button ${detail.quizHref ? "ghost" : "secondary"}`} href={detail.canvasUrl} target="_blank" rel="noopener noreferrer">Open in Canvas <Icon name="external" /></a>}
      </div>
    </header>
    {detail.externalTool && !detail.quizHref && <p className={styles.note}>This assignment is completed in an external tool that only Canvas can launch. Grove shows its status and syncs it about every 15 minutes.</p>}
    <dl className={styles.facts}>{shown.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="num">{value}</dd></div>)}</dl>
    <section className={styles.card} aria-labelledby="assignment-description">
      <h2 id="assignment-description">Description</h2>
      {detail.descriptionHtml
        ? <CanvasProse html={detail.descriptionHtml} />
        : <p className={styles.empty}>No description was provided for this assignment.</p>}
    </section>
  </main>;
}
