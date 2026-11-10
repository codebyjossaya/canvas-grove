import Link from "next/link";
import { EmptySyncState } from "./app-shell";
import { Icon } from "./icons";

type Assignment = { id: string; name: string; dueAt: Date | null; pointsPossible: string | null; courseName: string; courseCode: string | null };
type Announcement = { id: string; title: string; postedAt: Date | null; courseName: string | null };
type Course = { id: string; name: string; courseCode: string | null; currentGrade: string | null; currentScore: string | null };

export function Dashboard({ assignments, announcements, courses }: { assignments: Assignment[]; announcements: Announcement[]; courses: Course[] }) {
  const hasData = assignments.length + announcements.length + courses.length > 0;
  return <main className="dashboard">
    <header className="dashboard-head">
      <div><p className="eyebrow">Today</p><h1>Your academic day</h1><p>{hasData ? "Canvas work, ordered by what needs attention next." : "Assignments and announcements collect here after your first Canvas sync."}</p></div>
      <Link className="button secondary" href="/planner"><Icon name="calendar"/>Open planner</Link>
    </header>
    {!hasData && <section className="honest-banner"><Icon name="wifi"/><div><strong>Waiting for synced Canvas data</strong><p>Your Canvas connection is ready, but no course records have arrived yet.</p></div><Link className="button primary" href="/settings">Review sync</Link></section>}
    <div className="dashboard-grid data-grid">
      <section className="panel">
        <div className="section-head"><h2>Next up</h2><Link href="/planner">Full planner</Link></div>
        {assignments.length ? <div className="record-list agenda">{assignments.slice(0, 8).map((item) => <article key={item.id}><time dateTime={item.dueAt?.toISOString()}>{formatDate(item.dueAt)}</time><span className="agenda-line"/><div><strong>{item.name}</strong><small>{item.courseCode ?? item.courseName}{item.pointsPossible ? ` · ${item.pointsPossible} pts` : ""}</small></div></article>)}</div> : <EmptySyncState icon="check" title="Nothing upcoming" body="No upcoming assignments are cached."/>}
      </section>
      <section className="panel">
        <div className="section-head"><h2>Announcements</h2><Link href="/inbox">Inbox</Link></div>
        {announcements.length ? <div className="record-list pulse">{announcements.slice(0, 8).map((item) => <article key={item.id}><div><strong>{item.title}</strong><small>{item.courseName ?? "Canvas"} · {formatDate(item.postedAt)}</small></div></article>)}</div> : <EmptySyncState icon="inbox" title="No recent announcements" body="Announcements will appear here as Canvas publishes them."/>}
      </section>
    </div>
    {courses.length > 0 && <section className="courses">
      <div className="section-head"><h2>Current courses</h2><Link href="/courses">View all</Link></div>
      <div className="course-grid">{courses.slice(0, 6).map((course) => <Link className="course-card" href={`/courses/${course.id}`} key={course.id}><div className="course-body"><p>{course.courseCode ?? "Canvas course"}</p><h3>{course.name}</h3><footer><span>Current grade</span><strong>{course.currentGrade ?? (course.currentScore ? `${course.currentScore}%` : "Not posted")}</strong></footer></div></Link>)}</div>
    </section>}
  </main>;
}

function formatDate(value: Date | null) { return value ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(value) : "Recently"; }
