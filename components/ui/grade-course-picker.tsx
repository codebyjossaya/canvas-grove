import Link from "next/link";
import styles from "./grade-course-picker.module.css";

export type GradePickerCourse = {
  id: string;
  name: string;
  courseCode: string | null;
  termName: string | null;
  currentGrade: string | null;
  currentScore: string | number | null;
  favorite: boolean;
};

export function GradeCoursePicker({ courses }: { courses: GradePickerCourse[] }) {
  const ordered = [...courses].sort((left, right) => Number(right.favorite) - Number(left.favorite) || left.name.localeCompare(right.name));
  return <main className={styles.wrap}>
    <header className={styles.head}>
      <p className="eyebrow">Course grades</p>
      <h1>Grades live with each course.</h1>
      <p>Choose a course to see its current grade, assignment groups, posted results, and a private What-If workspace. Canvas Grove does not combine unrelated courses into one overall grade.</p>
    </header>
    {ordered.length ? <section className={styles.grid} aria-label="Choose a course for grades">
      {ordered.map(course => <Link className={styles.card} href={`/courses/${course.id}/grades`} key={course.id}>
        <span className={styles.mark} aria-hidden="true">{initials(course.courseCode || course.name)}</span>
        <span className={styles.copy}>
          <small>{course.courseCode || course.termName || "Canvas course"}</small>
          <strong>{course.name}</strong>
          <span>{course.termName || (course.favorite ? "Active course" : "Inactive course")}</span>
        </span>
        <span className={styles.grade}>
          <small>Current grade</small>
          <strong>{displayGrade(course)}</strong>
          <span>Open course grades <b aria-hidden="true">→</b></span>
        </span>
      </Link>)}
    </section> : <section className={styles.empty} role="status"><span aria-hidden="true">%</span><h2>No synced courses yet</h2><p>Connect Canvas and complete a sync. Course-specific grade pages will appear here.</p><Link className="button primary" href="/settings">Manage Canvas connection</Link></section>}
  </main>;
}

function displayGrade(course: GradePickerCourse) {
  if (course.currentGrade) return course.currentGrade;
  const score = Number(course.currentScore);
  return course.currentScore != null && Number.isFinite(score) ? `${score.toFixed(1)}%` : "Not posted";
}

function initials(value: string) {
  const parts = value.replace(/[^a-zA-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : value.slice(0, 2)).toUpperCase();
}
