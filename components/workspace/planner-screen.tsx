"use client";

import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useState, useTransition, type MouseEvent } from "react";
import { AppLink, useNavBase, withBase } from "@/components/ui/app-link";
import { Icon } from "@/components/ui/icons";
import { addDays, timeLabel, weekRangeLabel } from "@/lib/views/dates";
import type { CustomEventItem, PlannerView, WorkItem } from "@/lib/views/types";
import { CustomEventEditor, type EditorTarget } from "./custom-event-editor";
import { stateChip, WorkList } from "./work-row";
import styles from "./planner.module.css";
import { NAV_FORWARD } from "@/components/ui/page-transition";

export function plannerHref(view: "week" | "agenda", week?: string) {
  const params = new URLSearchParams();
  if (view === "agenda") params.set("view", "agenda");
  if (week) params.set("week", week);
  const query = params.toString();
  return `/planner${query ? `?${query}` : ""}`;
}

/** Plain left clicks are handled in-app; modified clicks (new tab, etc.) keep native link behavior. */
function plainClick(event: MouseEvent<HTMLAnchorElement>) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;
}

export function PlannerScreen({ view }: { view: PlannerView }) {
  const router = useRouter(), base = useNavBase();
  const [pending, startTransition] = useTransition();
  // The week being shown or navigated to. Updated optimistically on click, so the label flips at
  // once and repeated clicks keep stepping from the target week instead of re-requesting the same one.
  const [target, setTarget] = useOptimistic(`${view.view}|${view.weekStart}`);
  const [targetView, targetWeek] = target.split("|") as ["week" | "agenda", string];
  const prevWeek = addDays(targetWeek, -7), nextWeek = addDays(targetWeek, 7);
  const weekParam = (week: string) => week === view.thisWeek ? undefined : week;

  const go = (nextView: "week" | "agenda", week: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    startTransition(() => {
      setTarget(`${nextView}|${week}`);
      router.push(withBase(base, plannerHref(nextView, weekParam(week))), { scroll: false });
    });
  };

  // Warm the adjacent weeks so stepping is served from the router cache.
  const prefetchPrev = withBase(base, plannerHref(view.view, weekParam(view.prevWeek)));
  const prefetchNext = withBase(base, plannerHref(view.view, weekParam(view.nextWeek)));
  useEffect(() => { router.prefetch(prefetchPrev); router.prefetch(prefetchNext); }, [router, prefetchPrev, prefetchNext]);

  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const openEvent = (event: CustomEventItem) => setEditor({ mode: "edit", event });
  const max = Math.max(1, ...view.workload.map(day => day.points || day.count * 10));
  const label = targetWeek === view.weekStart ? view.weekLabel : weekRangeLabel(targetWeek);
  return <main className={`page wide ${styles.page}`}>
    <header className="page-head">
      <div className={styles.titleRow}>
        <div><h1>Planner</h1><p className="num" aria-live="polite">{targetView === "week" ? label : "Everything dated, day by day"}</p></div>
        <button type="button" className={`button primary ${styles.newEvent}`} onClick={() => setEditor({ mode: "new", day: view.days.find(day => day.today)?.key ?? view.weekStart })}><Icon name="plus" />New event</button>
      </div>
      <div className="page-actions">
        <nav className={styles.segmented} aria-label="Planner view">
          <AppLink href={plannerHref("week", weekParam(targetWeek))} onClick={go("week", targetWeek)} aria-current={targetView === "week" ? "page" : undefined}><Icon name="columns" />Week</AppLink>
          <AppLink href={plannerHref("agenda", weekParam(targetWeek))} onClick={go("agenda", targetWeek)} aria-current={targetView === "agenda" ? "page" : undefined}><Icon name="list" />Agenda</AppLink>
        </nav>
        <div className={styles.stepper} aria-busy={pending || undefined}>
          <AppLink className="button secondary icon" href={plannerHref(targetView, weekParam(prevWeek))} onClick={go(targetView, prevWeek)} aria-label="Previous week"><Icon name="chevron-left" /></AppLink>
          <AppLink className="button secondary" href={plannerHref(targetView)} onClick={go(targetView, view.thisWeek)} aria-disabled={targetWeek === view.thisWeek || undefined}>This week</AppLink>
          <AppLink className="button secondary icon" href={plannerHref(targetView, weekParam(nextWeek))} onClick={go(targetView, nextWeek)} aria-label="Next week"><Icon name="chevron-right" /></AppLink>
        </div>
      </div>
    </header>

    <section className={`card ${styles.workload}`} aria-labelledby="workload-title">
      <div className={styles.workloadHead}><h2 id="workload-title">Workload, next 14 days</h2><span>Open items, weighted by points</span></div>
      <ol className={styles.bars}>
        {view.workload.map(day => <li key={day.key} className={day.today ? styles.todayBar : undefined}>
          <span className={styles.barTrack} title={`${day.count} open ${day.count === 1 ? "item" : "items"}${day.points ? ` · ${day.points} pts` : ""}`}>
            <span className={`${styles.bar} ${(day.points || day.count * 10) / max > .66 ? styles.heavy : ""}`} style={{ height: `${day.count ? Math.max(10, ((day.points || day.count * 10) / max) * 100) : 0}%` }} />
          </span>
          <span className={styles.barCount}>{day.count || ""}</span>
          <span className={styles.barDay}><small>{day.weekday}</small>{day.day}</span>
          <span className="sr-only">{day.count} open items{day.points ? `, ${day.points} points` : ""}</span>
        </li>)}
      </ol>
    </section>

    <div className={pending ? styles.pending : undefined} aria-busy={pending || undefined}>
      {!view.hasAnyData ? <div className="empty-state"><span className="empty-icon"><Icon name="calendar" /></span><h2>Your planner is empty</h2><p>Canvas deadlines, events and planner notes appear here after a sync.</p><div className="actions"><AppLink className="button secondary" href="/settings">Check sync</AppLink></div></div>
        : view.view === "week" ? <WeekGrid view={view} onOpen={openEvent} /> : <Agenda view={view} onOpen={openEvent} />}
    </div>
    <CustomEventEditor target={editor} zone={view.zone} courses={view.courses} onClose={() => setEditor(null)} />
  </main>;
}

function customWhen(event: CustomEventItem, zone: string) {
  return event.allDay ? "All day" : `${timeLabel(event.startsAt, zone)} – ${timeLabel(event.endsAt, zone)}`;
}

/** One of the student's own events: dashed, tagged "Custom", opens the editor (never a Canvas link). */
function CustomEvent({ event, zone, onOpen, row }: { event: CustomEventItem; zone: string; onOpen: (event: CustomEventItem) => void; row?: boolean }) {
  return <li className={`${row ? styles.customRow : styles.item} ${styles.custom} c${event.color}`}>
    <button type="button" className={styles.itemTitle} onClick={() => onOpen(event)} aria-label={`Edit custom event ${event.title}`}>{event.title}</button>
    <span className={styles.itemMeta}><span className={`chip ${styles.customChip}`}>Custom</span>{event.course ? <span className="course-code">{event.course.code}</span> : null}<time dateTime={event.startsAt ?? event.startDate ?? undefined}>{customWhen(event, zone)}</time></span>
  </li>;
}

function Agenda({ view, onOpen }: { view: PlannerView; onOpen: (event: CustomEventItem) => void }) {
    const { now, zone } = view;
    return <div className={styles.agenda}>
      {view.agenda.length ? view.agenda.map(group => <section key={group.key} className={styles.day} aria-label={`${group.label}, ${group.sublabel}`}>
        <h2 className={styles.dayHead}><span>{group.label}</span><small>{group.sublabel}</small></h2>
        {group.custom?.length ? <ul className={styles.customList} aria-label="Custom events">{group.custom.map(event => <CustomEvent key={event.id} event={event} zone={zone} onOpen={onOpen} row />)}</ul> : null}
        {group.items.length > 0 && <WorkList items={group.items} now={now} zone={zone} />}
      </section>) : <div className="empty-state"><span className="empty-icon"><Icon name="check" /></span><h2>Nothing scheduled</h2><p>No dated work in the next four weeks.</p></div>}
      {view.undated.length > 0 && <section className={styles.day} aria-label="No due date"><h2 className={styles.dayHead}><span>No due date</span><small>{view.undated.length} open</small></h2><WorkList items={view.undated} now={now} zone={zone} when="date" /></section>}
    </div>;
  }

function WeekGrid({ view, onOpen }: { view: PlannerView; onOpen: (event: CustomEventItem) => void }) {
    return <div className={styles.week} role="list" aria-label={`Week of ${view.weekLabel}`}>
      {view.days.map(day => { const custom = day.custom ?? [], total = day.items.length + custom.length; return <section role="listitem" key={day.key} className={`${styles.column} ${day.today ? styles.today : ""}`} aria-label={`${day.label}, ${day.sublabel}, ${day.items.length} items${custom.length ? `, ${custom.length} custom` : ""}`}>
        <h2 className={styles.columnHead}><span>{day.weekday}</span><b className="num">{day.dayNumber}</b>{total > 0 && <span className="count">{total}</span>}</h2>
        <ul>
          {custom.map(event => <CustomEvent key={event.id} event={event} zone={view.zone} onOpen={onOpen} />)}
          {day.items.map(item => <WeekItem key={item.id} item={item} zone={view.zone} />)}
        </ul>
        {!total && <p className={styles.free}>Free</p>}
      </section>; })}
    </div>;
  }

function WeekItem({ item, zone }: { item: WorkItem; zone: string }) {
    const chip = stateChip(item);
    const done = ["submitted", "graded", "done", "excused", "late", "past"].includes(item.state);
    return <li className={`${styles.item} ${done ? styles.itemDone : ""} ${item.state === "overdue" || item.state === "missing" ? styles.itemLate : ""} ${item.course ? `c${item.course.color}` : ""}`}>
      {item.href ? <AppLink href={item.href} className={styles.itemTitle} transitionTypes={NAV_FORWARD}>{item.title}</AppLink> : <span className={styles.itemTitle}>{item.title}</span>}
      <span className={styles.itemMeta}>{item.course ? <span className="course-code">{item.course.code}</span> : <span>Personal</span>}<time dateTime={item.dueAt ?? undefined}>{timeLabel(item.dueAt, zone)}</time></span>
      {chip && <span className={`chip ${chip.tone}`}>{chip.label}</span>}
    </li>;
  }
