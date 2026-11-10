import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = postgres(databaseUrl, { max: 1 });

function assert(condition, message) { if (!condition) throw new Error(message); }
const users = await sql`select id from users where status='active' order by created_at limit 2`;
assert(users.length === 1, `Expected exactly one active acceptance tenant, found ${users.length}`);
const ownerId = users[0].id;

const report = await sql.begin(async (tx) => {
  await tx`select set_config('app.user_id', ${ownerId}, true)`;
  const [summary] = await tx`
    select
      (select count(*)::int from courses where owner_id=${ownerId} and deleted_at is null) courses,
      (select count(*)::int from assignments where owner_id=${ownerId} and deleted_at is null) assignments,
      (select count(*)::int from planner_items where owner_id=${ownerId} and deleted_at is null) planner,
      (select count(*)::int from announcements where owner_id=${ownerId}) announcements,
      (select count(*)::int from conversations where owner_id=${ownerId}) conversations,
      (select count(*)::int from hosted_browser_sessions where owner_id=${ownerId} and status='active' and revoked_at is null) active_sessions`;
  assert(summary.courses > 0, "Courses route has no persisted records");
  assert(summary.planner > 0, "Planner route has no persisted records");
  assert(summary.announcements > 0 || summary.conversations > 0, "Inbox route has neither announcements nor conversations");
  assert(summary.active_sessions > 0, "Settings route has no active Canvas session");

  const courseRows = await tx`
    select c.id,
      (select count(*)::int from assignments a where a.owner_id=c.owner_id and a.course_id=c.id and a.deleted_at is null) assignments,
      (select count(*)::int from planner_items p where p.owner_id=c.owner_id and p.course_id=c.id and p.deleted_at is null) planner,
      (select count(*)::int from announcements n where n.owner_id=c.owner_id and n.course_id=c.id) announcements,
      c.current_grade is not null or c.current_score is not null as has_grade
    from courses c where c.owner_id=${ownerId} and c.deleted_at is null order by c.id`;
  assert(courseRows.length === summary.courses, "Course list/detail loader count mismatch");
  for (const course of courseRows) {
    assert(/^[0-9a-f-]{36}$/i.test(course.id), "Course detail ID is not stable UUID");
    assert(JSON.stringify({ route: `/courses/${course.id}`, ...course }).length > 0, "Course detail model is not serializable");
  }
  return { ...summary, courseDetails: courseRows.length, courseDetailsWithScopedData: courseRows.filter((row) => row.assignments + row.planner + row.announcements > 0).length, courseDetailsWithGrades: courseRows.filter((row) => row.has_grade).length };
});

const isolated = await sql.begin(async (tx) => {
  await tx`select set_config('app.user_id', '00000000-0000-4000-8000-000000000001', true)`;
  const [row] = await tx`select count(*)::int count from courses`;
  return row.count;
});
assert(isolated === 0, "RLS exposed course rows to a different tenant");
console.log(JSON.stringify({ ok: true, routes: { today: report.assignments + report.announcements + report.courses, planner: report.planner, courses: report.courses, inbox: report.announcements + report.conversations, settings: report.active_sessions, courseDetails: report.courseDetails }, scopedCourseDetails: report.courseDetailsWithScopedData, gradedCourseDetails: report.courseDetailsWithGrades, rlsCrossTenantRows: isolated }));
await sql.end({ timeout: 3 });
