import { AppLink } from "@/components/ui/app-link";
import { Icon } from "@/components/ui/icons";
import { formatInstant } from "@/lib/time";
import { relativePast } from "@/lib/views/dates";
import type { DigestEntry, TodayView } from "@/lib/views/types";
import { ConnectAgentButton } from "./connect-agent/connect-agent-button";
import { WorkList } from "./work-row";
import styles from "./today.module.css";
import { NAV_FORWARD } from "@/components/ui/page-transition";

function greeting(now: string, zone: string) {
  const hour = Number(formatInstant(now, zone, { hour: "numeric", hourCycle: "h23" }));
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

export function TodayScreen({ view }: { view: TodayView }) {
  const { now, zone } = view;
  const openToday = view.today.filter(item => item.state === "open").length;
  const weekCount = view.week.reduce((sum, group) => sum + group.items.filter(item => item.state === "open").length, 0);
  const summary = [
    view.overdue.length ? `${view.overdue.length} overdue` : null,
    `${openToday} due today`,
    `${weekCount} more this week`,
  ].filter(Boolean).join(" · ");
  const clear = !view.overdue.length && !view.today.length && !view.week.length;

  return <main className={`page wide ${styles.page}`}>
    <header className="page-head">
      <div>
        <p className="eyebrow">{formatInstant(now, zone, { weekday: "long", month: "long", day: "numeric" })}</p>
        <h1>{greeting(now, zone)}{view.greetingName ? `, ${view.greetingName}` : ""}</h1>
        {view.hasAnyData && <p className="num">{summary}</p>}
      </div>
      <div className="page-actions"><ConnectAgentButton /><AppLink className="button secondary" href="/planner"><Icon name="calendar" />Planner</AppLink></div>
    </header>

    {!view.hasAnyData && <section className={styles.banner}>
      <Icon name="refresh" />
      <div><strong>Waiting for your first Canvas sync</strong><p>Once Canvas data arrives, your deadlines, announcements and grades collect here automatically.</p></div>
      <AppLink className="button primary" href="/settings">Check connection</AppLink>
    </section>}

    <div className={styles.grid}>
      <section className={styles.agenda} aria-labelledby="agenda-title">
        <h2 id="agenda-title" className="sr-only">Agenda</h2>
        {view.overdue.length > 0 && <div className={`${styles.group} ${styles.overdue}`}>
          <h3 className={styles.groupHead}><span>Overdue</span><span className="count">{view.overdue.length}</span><small>Past due, Canvas still accepts submissions</small></h3>
          <WorkList items={view.overdue} now={now} zone={zone} when="relative" label="Overdue work" />
        </div>}
        <div className={styles.group}>
          <h3 className={styles.groupHead}><span>Today</span>{view.today.length > 0 && <span className="count">{view.today.length}</span>}</h3>
          {view.today.length ? <WorkList items={view.today} now={now} zone={zone} label="Due today" /> : <p className={styles.quiet}>Nothing is due today.</p>}
        </div>
        {view.week.map(group => <div key={group.key} className={styles.group}>
          <h3 className={styles.groupHead}><span>{group.label}</span><small>{group.sublabel}</small></h3>
          <WorkList items={group.items} now={now} zone={zone} label={`Due ${group.label}`} />
        </div>)}
        {clear && view.hasAnyData && <div className="empty-state"><span className="empty-icon"><Icon name="check" /></span><h3>You’re clear for the next 7 days</h3><p>No synced deadlines need you this week.{view.laterCount ? ` ${view.laterCount} later ${view.laterCount === 1 ? "item is" : "items are"} on the planner.` : ""}</p></div>}
        {!clear && view.laterCount > 0 && <AppLink className={styles.later} href="/planner?view=agenda">{view.laterCount} more after this week <Icon name="arrow" /></AppLink>}
      </section>

      <aside className={styles.side}>
        <section className={`card ${styles.digest}`} aria-labelledby="digest-title">
          <div className={styles.cardHead}><h2 id="digest-title">Since you last looked</h2><span>{view.digest.sinceLabel}</span></div>
          {view.digest.entries.length ? <ul className={styles.digestList}>{view.digest.entries.map(entry => <DigestRow key={`${entry.kind}-${entry.id}`} entry={entry} now={now} zone={zone} />)}</ul>
            : <p className={styles.quiet}>Nothing new {view.digest.firstVisit ? "in the last 3 days" : "since your last visit"}. New announcements, messages and grades show up here.</p>}
        </section>
        {view.courses.length > 0 && <section className={`card ${styles.courses}`} aria-labelledby="courses-title">
          <div className={styles.cardHead}><h2 id="courses-title">Courses</h2><AppLink href="/courses">All courses</AppLink></div>
          <ul>{view.courses.map(course => <li key={course.id} className={`c${course.color}`}>
            <AppLink href={`/courses/${course.id}`} transitionTypes={NAV_FORWARD}><span className="course-dot" aria-hidden="true" /><span className={styles.courseName}><strong>{course.code}</strong><small>{course.name}</small></span>
              <span className={styles.courseDue}>{course.dueThisWeek ? `${course.dueThisWeek} due` : ""}</span>
              <span className={styles.courseGrade}>{course.grade ?? (course.score != null ? `${course.score.toFixed(1)}%` : "—")}</span></AppLink>
          </li>)}</ul>
        </section>}
      </aside>
    </div>
  </main>;
}

function DigestRow({ entry, now, zone }: { entry: DigestEntry; now: string; zone: string }) {
  const icon = entry.kind === "announcement" ? "megaphone" : entry.kind === "message" ? "mail" : "grade";
  const label = entry.kind === "announcement" ? "Announcement" : entry.kind === "message" ? `Message · ${entry.from}` : "Graded";
  return <li className={entry.course ? `c${entry.course.color}` : undefined}>
    <span className={`${styles.digestIcon} ${styles[entry.kind]}`}><Icon name={icon} /></span>
    <AppLink href={entry.href} className={styles.digestMain} transitionTypes={NAV_FORWARD}>
      <strong>{entry.title}</strong>
      <small>{entry.course && <span className="course-code">{entry.course.code}</span>}<span>{label}</span></small>
    </AppLink>
    <span className={styles.digestAside}>
      {entry.kind === "grade" && <b className="num">{entry.score != null && entry.points ? `${fmt(entry.score)}/${fmt(entry.points)}` : entry.grade}</b>}
      <time dateTime={entry.at}>{relativePast(entry.at, now, zone)}</time>
    </span>
  </li>;
}
function fmt(value: number) { return Number.isInteger(value) ? String(value) : value.toFixed(1); }
