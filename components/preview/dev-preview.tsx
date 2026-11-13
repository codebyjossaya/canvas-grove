import { notFound } from "next/navigation";
import { NavBaseProvider } from "@/components/ui/app-link";
import { AppShell, PageSkeleton } from "@/components/ui/app-shell";
import { CourseWorkspace, type CourseSection } from "@/components/ui/course-workspace";
import { QuizMode } from "@/components/ui/quiz-mode";
import { SidebarCourseList } from "@/components/ui/side-nav";
import { CoursesScreen } from "@/components/workspace/courses-screen";
import { GradeCoursePicker } from "@/components/ui/grade-course-picker";
import { InboxScreen } from "@/components/workspace/inbox-screen";
import { LoadError } from "@/components/workspace/load-error";
import { PlannerScreen } from "@/components/workspace/planner-screen";
import { QuizzesScreen } from "@/components/workspace/quizzes-screen";
import { SettingsScreen } from "@/components/workspace/settings-screen";
import { TodayScreen } from "@/components/workspace/today-screen";
import { buildCourses, buildGradesOverview, buildInbox, buildPlanner, buildSidebarCourses, buildToday } from "@/lib/views/build";
import { FixtureFetchShim } from "./fixture-fetch-shim";
import { FIXTURE_ZONE, fixtureRows } from "./fixture-rows";

// DEV-ONLY. Mounted by app/dev-preview, which 404s outside `next dev`.
const sections = new Set(["assignments", "announcements", "files", "syllabus", "modules", "pages", "grades"]);
export const PREVIEW_BASE = "/dev-preview";

export function DevPreview({ slug, query }: { slug: string[]; query: Record<string, string | undefined> }) {
  const now = new Date(), rows = fixtureRows(now), zone = FIXTURE_ZONE;
  const [first, second, third] = slug;
  if (first === "quiz") return <NavBaseProvider base={PREVIEW_BASE}><FixtureFetchShim /><QuizMode quizId={second ?? "q-ch9"} /></NavBaseProvider>;

  let body: React.ReactNode;
  if (!first) body = <TodayScreen view={buildToday(rows, now, zone, { since: new Date(now.getTime() - 28 * 3_600_000) }, "Jordan")} />;
  else if (first === "planner") body = <PlannerScreen view={buildPlanner(rows, now, zone, { weekStart: query.week, view: query.view })} />;
  else if (first === "inbox") body = <InboxScreen view={buildInbox(rows, rows.messages, { tab: query.tab, thread: query.c, announcement: query.a }, zone)} now={now.toISOString()} />;
  else if (first === "courses" && !second) body = <CoursesScreen view={buildCourses(rows, now, zone, query.view)} />;
  else if (first === "courses" && second) {
    if (third && !sections.has(third)) notFound();
    body = <CourseWorkspace key={`${second}`} courseId={second} active={(third as CourseSection | undefined) ?? "overview"} />;
  }
  else if (first === "grades") { const overview = buildGradesOverview(rows); body = <GradeCoursePicker courses={rows.courses.map(course => ({ ...course, missing: overview.courses.find(item => item.id === course.id)?.missing }))} recent={overview.recent} now={now.toISOString()} zone={zone} />; }
  else if (first === "quizzes") body = <QuizzesScreen />;
  else if (first === "settings") body = <SettingsScreen />;
  else if (first === "states") {
    const empty = { ...rows, courses: [], assignments: [], submissions: [], planner: [], announcements: [], conversations: [] };
    body = second === "loading" ? <PageSkeleton label="Loading today" rows={8} /> : second === "error" ? <LoadError what="your agenda" /> : second === "empty-planner" ? <PlannerScreen view={buildPlanner(empty, now, zone, {})} /> : second === "empty-inbox" ? <InboxScreen view={buildInbox(empty, [], {}, zone)} now={now.toISOString()} /> : <TodayScreen view={buildToday(empty, now, zone, { since: null }, "Jordan")} />;
  }
  else notFound();

  return <NavBaseProvider base={PREVIEW_BASE}>
    <FixtureFetchShim />
    <AppShell courses={<SidebarCourseList courses={buildSidebarCourses(rows.courses)} />} user={<span className="preview-avatar" aria-label="Preview user">JL</span>}>{body}</AppShell>
  </NavBaseProvider>;
}
