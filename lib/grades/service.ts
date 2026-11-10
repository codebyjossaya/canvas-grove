import "server-only";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { withTenantTransaction } from "@/lib/db";
import { assignmentGroups, assignments, courses, gradeScenarios, submissions, syncCursors } from "@/lib/db/schema";
import type { AuthContext } from "@/lib/db/auth-context";
import { calculateGrade, validateHypotheticalScores, type GradeAssignment, type GradeGroup } from "./engine";

function numberOrNull(value: string | number | null | undefined) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function assignmentModel(row: typeof assignments.$inferSelect, submission: typeof submissions.$inferSelect | null) {
  const source = record(row.sourcePayload);
  const score = numberOrNull(submission?.score);
  return {
    id: row.id, canvasId: row.canvasAssignmentId, name: row.name, groupId: row.assignmentGroupId,
    dueAt: row.dueAt, pointsPossible: numberOrNull(row.pointsPossible), score, grade: submission?.grade ?? null,
    status: submission?.state ?? (row.dueAt && row.dueAt < new Date() ? "unsubmitted" : "upcoming"),
    excused: submission?.excused ?? false, missing: submission?.missing ?? false, late: submission?.late ?? false,
    omitted: source.omit_from_final_grade === true, extraCredit: numberOrNull(row.pointsPossible) === 0 && score != null && score > 0,
  };
}
function engineAssignment(item: ReturnType<typeof assignmentModel>): GradeAssignment {
  return { id: item.id, canvasId: item.canvasId, groupId: item.groupId ?? "ungrouped", pointsPossible: item.pointsPossible, score: item.score,
    excused: item.excused, omitted: item.omitted, ungraded: item.score == null, extraCredit: item.extraCredit };
}
function engineGroup(row: typeof assignmentGroups.$inferSelect): GradeGroup {
  return { id: row.id, name: row.name, weight: numberOrNull(row.groupWeight) ?? 0, dropLowest: row.dropLowest, dropHighest: row.dropHighest, neverDropCanvasIds: row.neverDropCanvasIds };
}

export async function listGrades(ctx: AuthContext, courseId?: string | null) {
  return withTenantTransaction(ctx.ownerId, async (tx) => {
    const courseRows = await tx.select().from(courses).where(and(
      eq(courses.ownerId, ctx.ownerId),
      isNull(courses.deletedAt),
      courseId ? eq(courses.id, courseId) : undefined,
    )).orderBy(courses.name);
    const output = [];
    for (const course of courseRows) {
      const [groups, joined] = await Promise.all([
        tx.select().from(assignmentGroups).where(and(eq(assignmentGroups.ownerId, ctx.ownerId), eq(assignmentGroups.courseId, course.id), isNull(assignmentGroups.deletedAt))).orderBy(asc(assignmentGroups.position)),
        tx.select({ assignment: assignments, submission: submissions }).from(assignments).leftJoin(submissions, and(eq(submissions.ownerId, ctx.ownerId), eq(submissions.assignmentId, assignments.id)))
          .where(and(eq(assignments.ownerId, ctx.ownerId), eq(assignments.courseId, course.id), isNull(assignments.deletedAt))).orderBy(assignments.id, desc(submissions.attempt)),
      ]);
      const seen = new Set<string>();
      const mapped = joined.flatMap((row) => {
        if (seen.has(row.assignment.id)) return [];
        seen.add(row.assignment.id);
        return [assignmentModel(row.assignment, row.submission)];
      });
      const groupModels = groups.map(engineGroup);
      if (mapped.some((item) => !item.groupId)) groupModels.push({ id: "ungrouped", name: "Assignments", weight: 0, dropLowest: 0, dropHighest: 0, neverDropCanvasIds: [] });
      const current = calculateGrade({ weighted: course.applyAssignmentGroupWeights, groups: groupModels, assignments: mapped.map(engineAssignment) });
      output.push({
        course: { id: course.id, name: course.name, courseCode: course.courseCode },
        summary: { currentPercent: numberOrNull(course.currentScore) ?? current.percent, projectedPercent: current.percent, maximumPercent: null, schemeLabel: course.currentGrade, weighted: course.applyAssignmentGroupWeights },
        groups: current.groups.map((group) => {
          const source = groups.find((row) => row.id === group.id);
          return { ...group, dropRules: { dropLowest: source?.dropLowest ?? 0, dropHighest: source?.dropHighest ?? 0, neverDropCanvasIds: source?.neverDropCanvasIds ?? [] } };
        }),
        assignments: mapped,
      });
    }
    const cursors = await tx.select().from(syncCursors).where(and(eq(syncCursors.ownerId, ctx.ownerId), eq(syncCursors.resourceType, "course_content"))).orderBy(desc(syncCursors.lastSuccessAt));
    const lastSyncedAt = cursors[0]?.lastSuccessAt ?? null;
    return { courses: output, lastSyncedAt, stale: !lastSyncedAt || Date.now() - lastSyncedAt.getTime() > 3_600_000 };
  });
}

export async function listGradeScenarios(ctx: AuthContext, courseId: string) {
  return withTenantTransaction(ctx.ownerId, async (tx) => {
    const owned = await tx.select({ id: courses.id }).from(courses).where(and(eq(courses.ownerId, ctx.ownerId), eq(courses.id, courseId), isNull(courses.deletedAt))).limit(1);
    if (!owned[0]) return null;
    return tx.select().from(gradeScenarios).where(and(eq(gradeScenarios.ownerId, ctx.ownerId), eq(gradeScenarios.courseId, courseId))).orderBy(desc(gradeScenarios.updatedAt));
  });
}

export async function saveGradeScenario(ctx: AuthContext, input: { id?: string; courseId: string; name: string; scores: unknown }) {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new Error("INVALID_SCENARIO_NAME");
  const scores = validateHypotheticalScores(input.scores);
  return withTenantTransaction(ctx.ownerId, async (tx) => {
    const owned = await tx.select({ id: courses.id }).from(courses).where(and(eq(courses.ownerId, ctx.ownerId), eq(courses.id, input.courseId), isNull(courses.deletedAt))).limit(1);
    if (!owned[0]) return null;
    if (input.id) {
      return (await tx.update(gradeScenarios).set({ name, hypotheticalScores: scores, updatedAt: new Date() }).where(and(eq(gradeScenarios.ownerId, ctx.ownerId), eq(gradeScenarios.id, input.id), eq(gradeScenarios.courseId, input.courseId))).returning())[0] ?? null;
    }
    return (await tx.insert(gradeScenarios).values({ ownerId: ctx.ownerId, courseId: input.courseId, name, hypotheticalScores: scores }).returning())[0];
  });
}

export async function deleteGradeScenario(ctx: AuthContext, id: string) {
  return withTenantTransaction(ctx.ownerId, async (tx) => (await tx.delete(gradeScenarios).where(and(eq(gradeScenarios.ownerId, ctx.ownerId), eq(gradeScenarios.id, id))).returning({ id: gradeScenarios.id }))[0] ?? null);
}
