import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { EmptySyncState, PageSkeleton } from "@/components/ui/app-shell";
import { CourseFavoriteToggle } from "@/components/ui/course-favorite-toggle";
import { OnboardingGate } from "@/components/ui/onboarding-gate";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { tenantRepository } from "@/lib/db/repository";
import styles from "./courses.module.css";

export default function CoursesPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  return <Suspense fallback={<PageSkeleton label="Loading courses"/>}><WithParams searchParams={searchParams} /></Suspense>;
}

async function WithParams({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  return <OnboardingGate><Courses view={view === "inactive" ? "inactive" : "active"} /></OnboardingGate>;
}

async function Courses({ view }: { view: "active" | "inactive" }) {
  const session = await auth();
  if (!session.userId) redirect("/sign-in");
  const courses = await tenantRepository(await ensureUserForClerk(session.userId)).listCourses();
  const activeCount = courses.filter(course => course.favorite).length;
  const inactiveCount = courses.length - activeCount;
  const visible = courses.filter(course => view === "active" ? course.favorite : !course.favorite);

  return <main className="dashboard route-page">
      <header className={`dashboard-head ${styles.heading}`}>
        <div><p className="eyebrow">Courses</p><h1>Your learning spaces.</h1><p>Open a course, find its materials, or keep past classes close by.</p></div>
        <div className={styles.summary} aria-label="Course totals"><span><strong>{activeCount}</strong> active</span><i aria-hidden="true" /><span><strong>{courses.length}</strong> synced</span></div>
      </header>
      <nav className={styles.tabs} aria-label="Course visibility">
        <Link href="/courses" aria-current={view === "active" ? "page" : undefined}>Active <span>{activeCount}</span></Link>
        <Link href="/courses?view=inactive" aria-current={view === "inactive" ? "page" : undefined}>Inactive <span>{inactiveCount}</span></Link>
      </nav>
      {visible.length ? <section className={styles.grid} aria-label={`${view} courses`}>
        {visible.map((course, index) => <article className={styles.card} key={course.id} style={{ "--course-hue": String((index * 47 + 118) % 360) } as React.CSSProperties}>
          <div className={styles.cardTop}><span className={styles.courseMark} aria-hidden="true">{initials(course.courseCode ?? course.name)}</span><CourseFavoriteToggle courseId={course.id} initialActive={course.favorite} compact /></div>
          <Link className={styles.cardLink} href={`/courses/${course.id}`}>
            <span className={styles.code}>{course.courseCode ?? "Canvas course"}</span>
            <h2>{course.name}</h2>
            <span className={styles.term}>{course.termName ?? course.workflowState ?? "Current course"}</span>
            <span className={styles.open}>Open course <b aria-hidden="true">→</b></span>
          </Link>
          <div className={styles.cardFoot}><span>Current grade</span><strong>{course.currentGrade ?? (course.currentScore != null ? `${course.currentScore}%` : "Not posted")}</strong></div>
        </article>)}
      </section> : <EmptySyncState icon="book" title={view === "active" ? "No active courses" : "No inactive courses"} body={view === "active" ? "Canvas has no favorite courses. Use Inactive to restore one." : "Every synced course is active."} />}
    </main>;
}

function initials(value: string) {
  const parts = value.replace(/[^a-zA-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : value.slice(0, 2)).toUpperCase();
}
