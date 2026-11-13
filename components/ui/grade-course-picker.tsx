import { relativePast } from "@/lib/views/dates";
import { courseColor } from "@/lib/views/build";
import type { RecentGrade } from "@/lib/views/types";
import { AppLink } from "./app-link";
import { Icon } from "./icons";
import styles from "./grade-course-picker.module.css";
import { NAV_FORWARD } from "@/components/ui/page-transition";

export type GradePickerCourse = {
  id: string;
  name: string;
  courseCode: string | null;
  termName: string | null;
  currentGrade: string | null;
  currentScore: string | number | null;
  favorite: boolean;
  graded?: number;
  missing?: number;
};

/** Course-by-course grade index. Each row opens that course's gradebook and What-If tools. */
export function GradeCoursePicker({ courses, recent = [], now, zone = "UTC" }: { courses: GradePickerCourse[]; recent?: RecentGrade[]; now?: string; zone?: string }) {
  const ordered = [...courses].sort((left, right) => Number(right.favorite) - Number(left.favorite) || left.name.localeCompare(right.name));
  const active = ordered.filter(course => course.favorite), inactive = ordered.filter(course => !course.favorite);
  return <main className={`page wide ${styles.page}`}>
    <header className="page-head">
      <div><h1>Course grades</h1><p>Grades live with each course. Canvas Grove does not combine unrelated courses into one overall grade.</p></div>
      <div className="page-actions"><AppLink className="button secondary" href="/courses"><Icon name="book" />Courses</AppLink></div>
    </header>
    {ordered.length ? <div className={styles.layout}>
      <div className={styles.tables}>
        <CourseTable title="Active" courses={active} />
        {inactive.length > 0 && <CourseTable title="Inactive" courses={inactive} />}
      </div>
      <section className={`card ${styles.recent}`} aria-labelledby="recent-grades">
        <div className={styles.recentHead}><h2 id="recent-grades">Recently graded</h2></div>
        {recent.length ? <ul>{recent.map(item => <li key={item.id} className={`c${item.course.color}`}>
          <AppLink href={`/courses/${item.course.id}/grades`} transitionTypes={NAV_FORWARD}>
            <span className={styles.recentMain}><strong>{item.title}</strong><span className="course-code">{item.course.code}</span></span>
            <span className={styles.recentScore}><b className="num">{item.score != null && item.points ? `${fmt(item.score)}/${fmt(item.points)}` : item.grade ?? "—"}</b>{now && <time dateTime={item.gradedAt}>{relativePast(item.gradedAt, now, zone)}</time>}</span>
          </AppLink>
        </li>)}</ul> : <p className={styles.quiet}>New scores appear here as instructors post them.</p>}
      </section>
    </div> : <section className="empty-state" role="status"><span className="empty-icon"><Icon name="grade" /></span><h2>No synced courses yet</h2><p>Connect Canvas and complete a sync. Course-specific grade pages will appear here.</p><div className="actions"><AppLink className="button primary" href="/settings">Manage Canvas connection</AppLink></div></section>}
  </main>;
}

function CourseTable({ title, courses }: { title: string; courses: GradePickerCourse[] }) {
  if (!courses.length) return null;
  return <section aria-label={`${title} courses`} className={styles.table}>
    <h2 className="section-title">{title}</h2>
    <ul>{courses.map(course => {
      const score = Number(course.currentScore), hasScore = course.currentScore != null && Number.isFinite(score);
      return <li key={course.id} className={`c${courseColor(course.id)}`}>
        <AppLink href={`/courses/${course.id}/grades`} className={styles.row} transitionTypes={NAV_FORWARD}>
          <span className="course-dot" aria-hidden="true" />
          <span className={styles.name}><strong>{course.name}</strong><small>{[course.courseCode, course.termName].filter(Boolean).join(" · ") || "Canvas course"}</small></span>
          <span className={styles.meter} aria-hidden="true"><i style={{ width: `${hasScore ? Math.max(0, Math.min(100, score)) : 0}%` }} /></span>
          <span className={styles.grade}><strong className="num">{course.currentGrade ?? (hasScore ? `${score.toFixed(1)}%` : "—")}</strong><small className="num">{course.currentGrade && hasScore ? `${score.toFixed(1)}%` : hasScore ? "" : "Not posted"}</small></span>
          <span className={styles.flags}>{course.missing ? <span className="chip danger">{course.missing} missing</span> : null}</span>
          <Icon name="chevron-right" className={styles.chev} />
        </AppLink>
      </li>;
    })}</ul>
  </section>;
}

function fmt(value: number) { return Number.isInteger(value) ? String(value) : value.toFixed(1); }
