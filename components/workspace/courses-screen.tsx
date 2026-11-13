import { AppLink } from "@/components/ui/app-link";
import { CourseFavoriteToggle } from "@/components/ui/course-favorite-toggle";
import { Icon } from "@/components/ui/icons";
import { dueLabel } from "@/lib/views/dates";
import type { CourseCard, CoursesView } from "@/lib/views/types";
import styles from "./courses.module.css";
import { NAV_FORWARD } from "@/components/ui/page-transition";

export function CoursesScreen({ view }: { view: CoursesView }) {
  const visible = view.view === "active" ? view.active : view.inactive;
  return <main className={`page wide ${styles.page}`}>
    <header className="page-head">
      <div><h1>Courses</h1><p>Your active Canvas courses, what’s next in each, and where you stand.</p></div>
      <div className="page-actions"><AppLink className="button secondary" href="/grades"><Icon name="grade" />Course grades</AppLink></div>
    </header>
    <nav className={styles.tabs} aria-label="Course visibility">
      <AppLink href="/courses" aria-current={view.view === "active" ? "page" : undefined}>Active <span className="count">{view.active.length}</span></AppLink>
      <AppLink href="/courses?view=inactive" aria-current={view.view === "inactive" ? "page" : undefined}>Inactive <span className="count">{view.inactive.length}</span></AppLink>
      <span className={styles.tabHint}>Active courses are your Canvas favorites. Star a course to change it.</span>
    </nav>
    {visible.length ? <ul className={styles.grid} aria-label={`${view.view} courses`}>{visible.map(course => <CourseTile key={course.id} course={course} now={view.now} zone={view.zone} />)}</ul>
      : <div className="empty-state"><span className="empty-icon"><Icon name="book" /></span><h2>{view.view === "active" ? "No active courses" : "No inactive courses"}</h2><p>{view.view === "active" ? (view.inactive.length ? "None of your synced courses are favorites in Canvas. Open Inactive and star the ones you’re taking." : "Courses appear here after your first Canvas sync.") : "Every synced course is active."}</p>{view.view === "active" && !view.inactive.length && <div className="actions"><AppLink className="button secondary" href="/settings">Check sync</AppLink></div>}</div>}
  </main>;
}

function CourseTile({ course, now, zone }: { course: CourseCard; now: string; zone: string }) {
  return <li className={`${styles.tile} c${course.color}`}>
    <div className={styles.tileTop}>
      <span className="course-code">{course.code}</span>
      {course.term && <span className={styles.term}>{course.term}</span>}
      <CourseFavoriteToggle courseId={course.id} initialActive={course.favorite} compact />
    </div>
    <AppLink className={styles.tileLink} href={`/courses/${course.id}`} transitionTypes={NAV_FORWARD}><h2>{course.name}</h2></AppLink>
    <div className={styles.stats}>
      <AppLink href={`/courses/${course.id}/grades`} className={styles.grade}><small>Grade</small><strong className="num">{course.grade ?? (course.score != null ? `${course.score.toFixed(1)}%` : "—")}</strong>{course.grade && course.score != null && <span className="num">{course.score.toFixed(1)}%</span>}</AppLink>
      <div className={styles.week}><small>This week</small><strong className="num">{course.dueThisWeek}</strong><span>due</span>{course.missing > 0 && <span className="chip danger">{course.missing} overdue</span>}</div>
    </div>
    <div className={styles.next}>
      {course.next ? <><small>Next up</small><span className={styles.nextTitle}>{course.next.title}</span><time dateTime={course.next.dueAt ?? undefined}>{dueLabel(course.next.dueAt, zone, now)}</time></> : <span className={styles.nothing}>Nothing upcoming</span>}
    </div>
  </li>;
}
