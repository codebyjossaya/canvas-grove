import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { EmptySyncState, PageSkeleton } from "@/components/ui/app-shell";
import { OnboardingGate } from "@/components/ui/onboarding-gate";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { tenantRepository } from "@/lib/db/repository";

export default function PlannerPage() { return <Suspense fallback={<PageSkeleton label="Loading planner"/>}><OnboardingGate><ProtectedPlanner/></OnboardingGate></Suspense>; }
async function ProtectedPlanner() {
  const session = await auth(); if (!session.userId) redirect("/sign-in");
  const repo = tenantRepository(await ensureUserForClerk(session.userId));
  const items = await repo.listPlannerWithCourse();
  return <main className="dashboard route-page"><header className="dashboard-head"><div><p className="eyebrow">Planner</p><h1>Plan the work.</h1><p>Canvas deadlines and events in one chronological view.</p></div></header>
    <section className="planner-frame"><div className="week-strip">{weekDays().map(({ day, date, today }) => <div key={`${day}-${date}`} className={today ? "today" : ""}><span>{day}</span><strong>{date}</strong></div>)}</div>
      {items.length ? <div className="timeline-list">{items.map((item) => <article key={item.id}><time dateTime={(item.dueAt ?? item.startsAt)?.toISOString()}>{formatWhen(item.dueAt ?? item.startsAt)}</time><div><strong>{item.title}</strong><small>{item.courseName ?? "Personal"} · {humanKind(item.kind)}</small></div><span className={`record-status ${item.status}`}>{item.status.replace("_", " ")}</span></article>)}</div> : <EmptySyncState icon="calendar" title="Your week is clear" body="No Canvas deadlines or planner items are cached." action={<Link className="button primary" href="/settings">Check sync</Link>}/>}</section>
  </main>;
}
function weekDays() { const now = new Date(); const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7)); return Array.from({ length: 7 }, (_, index) => { const date = new Date(monday); date.setDate(monday.getDate() + index); return { day: date.toLocaleDateString("en-US", { weekday: "short" }), date: date.getDate(), today: date.toDateString() === now.toDateString() }; }); }
function formatWhen(value: Date | null) { return value ? new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(value) : "No date"; }
function humanKind(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
