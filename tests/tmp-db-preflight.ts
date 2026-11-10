import postgres from "postgres";
void (async () => {
  const db = postgres(process.env.DATABASE_URL!);
  const owner = (await db.unsafe("select id from users where status='active' order by created_at limit 1"))[0];
  const started = performance.now();
  const row = await db.begin(async (tx) => {
    await tx.unsafe("select set_config('app.user_id',$1,true)", [owner.id]);
    return (await tx.unsafe("select q.title,q.supported,q.due_at,q.unlock_at,q.lock_at,q.allowed_attempts,qa.workflow_state,qa.attempt,qa.finished_at from quizzes q join courses c on c.owner_id=q.owner_id and c.id=q.course_id left join lateral (select workflow_state,attempt,finished_at from quiz_attempts where owner_id=q.owner_id and quiz_id=q.id order by attempt desc limit 1) qa on true where q.deleted_at is null and q.title ilike '%Quiz 08%' order by (c.name ilike '%marketing%') desc,q.synced_at desc limit 1"))[0];
  });
  console.log(JSON.stringify({ elapsedMs: Math.round((performance.now() - started) * 10) / 10, found: Boolean(row), title: row?.title ?? null, supported: row?.supported ?? null, workflowState: row?.workflow_state ?? null, attempt: row?.attempt ?? 0 }));
  await db.end();
})();
