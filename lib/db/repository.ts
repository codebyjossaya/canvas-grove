import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { withTenantTransaction } from "./index";
import { announcements, assignments, canvasAccounts, conversations, courses, plannerItems, quizAttempts, quizzes } from "./schema";
import type { AuthContext } from "./auth-context";

// Repositories accept AuthContext, never a caller-supplied owner id. Keep this
// pattern for every query even when PostgreSQL RLS is also enabled.
export function tenantRepository(ctx: AuthContext) {
  return {
    listAccounts: () => withTenantTransaction(ctx.ownerId, (tx) => tx.select().from(canvasAccounts).where(eq(canvasAccounts.ownerId, ctx.ownerId))),
    listCourses: () => withTenantTransaction(ctx.ownerId, (tx) => tx.select().from(courses).where(and(eq(courses.ownerId, ctx.ownerId), isNull(courses.deletedAt))).orderBy(courses.name)),
    getCourse: (courseId: string) => withTenantTransaction(ctx.ownerId, async (tx) => (await tx.select().from(courses).where(and(eq(courses.ownerId, ctx.ownerId), eq(courses.id, courseId), isNull(courses.deletedAt))).limit(1))[0] ?? null),
    listQuizzes: () => withTenantTransaction(ctx.ownerId, (tx) => tx.select({
      id: quizzes.id, courseId: quizzes.courseId, courseName: courses.name, courseCode: courses.courseCode,
      canvasQuizId: quizzes.canvasQuizId, canvasAssignmentId: quizzes.canvasAssignmentId, canvasCourseId: courses.canvasCourseId, engine: quizzes.engine, title: quizzes.title,
      dueAt: quizzes.dueAt, unlockAt: quizzes.unlockAt, lockAt: quizzes.lockAt,
      pointsPossible: quizzes.pointsPossible, timeLimitMinutes: quizzes.timeLimitMinutes,
      allowedAttempts: quizzes.allowedAttempts, questionCount: quizzes.questionCount,
      published: quizzes.published, lockedForUser: quizzes.lockedForUser,
      lockExplanation: quizzes.lockExplanation, htmlUrl: quizzes.htmlUrl, supported: quizzes.supported,
      unsupportedReason: quizzes.unsupportedReason, syncedAt: quizzes.syncedAt,
    }).from(quizzes).innerJoin(courses, and(eq(quizzes.courseId, courses.id), eq(courses.ownerId, ctx.ownerId)))
      .where(and(eq(quizzes.ownerId, ctx.ownerId), isNull(quizzes.deletedAt), isNull(courses.deletedAt)))
      .orderBy(asc(quizzes.dueAt), quizzes.title)),
    getQuiz: (quizId: string) => withTenantTransaction(ctx.ownerId, async (tx) => (await tx.select({
      quiz: quizzes, courseName: courses.name, courseCode: courses.courseCode, canvasCourseId: courses.canvasCourseId,
    }).from(quizzes).innerJoin(courses, and(eq(quizzes.courseId, courses.id), eq(courses.ownerId, ctx.ownerId)))
      .where(and(eq(quizzes.ownerId, ctx.ownerId), eq(quizzes.id, quizId), isNull(quizzes.deletedAt), isNull(courses.deletedAt))).limit(1))[0] ?? null),
    listQuizAttempts: (quizId: string) => withTenantTransaction(ctx.ownerId, (tx) => tx.select().from(quizAttempts)
      .where(and(eq(quizAttempts.ownerId, ctx.ownerId), eq(quizAttempts.quizId, quizId))).orderBy(desc(quizAttempts.attempt))),
    listQuizAttemptsForQuizzes: (quizIds: string[]) => quizIds.length === 0 ? Promise.resolve([]) : withTenantTransaction(ctx.ownerId, (tx) => tx.select().from(quizAttempts)
      .where(and(eq(quizAttempts.ownerId, ctx.ownerId), inArray(quizAttempts.quizId, quizIds))).orderBy(quizAttempts.quizId, desc(quizAttempts.attempt))),
    listAssignmentsForCourse: (courseId: string) => withTenantTransaction(ctx.ownerId, (tx) => tx.select().from(assignments).where(and(eq(assignments.ownerId, ctx.ownerId), eq(assignments.courseId, courseId), isNull(assignments.deletedAt))).orderBy(asc(assignments.dueAt), assignments.name)),
    listPlannerForCourse: (courseId: string) => withTenantTransaction(ctx.ownerId, (tx) => tx.select().from(plannerItems).where(and(eq(plannerItems.ownerId, ctx.ownerId), eq(plannerItems.courseId, courseId), isNull(plannerItems.deletedAt))).orderBy(asc(plannerItems.dueAt), asc(plannerItems.startsAt), plannerItems.title)),
    listAnnouncementsForCourse: (courseId: string) => withTenantTransaction(ctx.ownerId, (tx) => tx.select().from(announcements).where(and(eq(announcements.ownerId, ctx.ownerId), eq(announcements.courseId, courseId))).orderBy(desc(announcements.postedAt))),
    setCourseFavorite: (courseId: string, favorite: boolean) => withTenantTransaction(ctx.ownerId, async (tx) => (await tx.update(courses).set({ favorite, updatedAt: new Date() }).where(and(eq(courses.ownerId, ctx.ownerId), eq(courses.id, courseId), isNull(courses.deletedAt))).returning())[0] ?? null),
    listUpcomingAssignments: () => withTenantTransaction(ctx.ownerId, (tx) => tx.select().from(assignments).where(and(eq(assignments.ownerId, ctx.ownerId), isNull(assignments.deletedAt))).orderBy(assignments.dueAt)),
    listPlanner: () => withTenantTransaction(ctx.ownerId, (tx) => tx.select().from(plannerItems).where(and(eq(plannerItems.ownerId, ctx.ownerId), isNull(plannerItems.deletedAt))).orderBy(desc(plannerItems.updatedAt))),
    listUpcomingAssignmentsWithCourse: () => withTenantTransaction(ctx.ownerId, (tx) => tx.select({
      id: assignments.id, name: assignments.name, dueAt: assignments.dueAt, pointsPossible: assignments.pointsPossible,
      workflowState: assignments.workflowState, courseName: courses.name, courseCode: courses.courseCode,
    }).from(assignments).innerJoin(courses, and(eq(assignments.courseId, courses.id), eq(courses.ownerId, ctx.ownerId)))
      .where(and(eq(assignments.ownerId, ctx.ownerId), isNull(assignments.deletedAt), isNull(courses.deletedAt), or(isNull(assignments.dueAt), gte(assignments.dueAt, new Date(Date.now() - 86_400_000)))))
      .orderBy(asc(assignments.dueAt), assignments.name)),
    listPlannerWithCourse: () => withTenantTransaction(ctx.ownerId, (tx) => tx.select({
      id: plannerItems.id, title: plannerItems.title, kind: plannerItems.kind, startsAt: plannerItems.startsAt,
      dueAt: plannerItems.dueAt, status: plannerItems.status, source: plannerItems.source, courseName: courses.name,
    }).from(plannerItems).leftJoin(courses, and(eq(plannerItems.courseId, courses.id), eq(courses.ownerId, ctx.ownerId)))
      .where(and(eq(plannerItems.ownerId, ctx.ownerId), isNull(plannerItems.deletedAt)))
      .orderBy(asc(plannerItems.dueAt), asc(plannerItems.startsAt), plannerItems.title)),
    listConversations: () => withTenantTransaction(ctx.ownerId, (tx) => tx.select({
      id: conversations.id, subject: conversations.subject, workflowState: conversations.workflowState,
      lastMessageAt: conversations.lastMessageAt, messageCount: conversations.messageCount, starred: conversations.starred,
      participants: conversations.participants, courseName: courses.name,
    }).from(conversations).leftJoin(courses, and(eq(conversations.courseId, courses.id), eq(courses.ownerId, ctx.ownerId)))
      .where(eq(conversations.ownerId, ctx.ownerId)).orderBy(desc(conversations.lastMessageAt))),
    listAnnouncements: () => withTenantTransaction(ctx.ownerId, (tx) => tx.select({
      id: announcements.id, title: announcements.title, bodyHtml: announcements.bodyHtml, postedAt: announcements.postedAt,
      htmlUrl: announcements.htmlUrl, courseName: courses.name,
    }).from(announcements).leftJoin(courses, and(eq(announcements.courseId, courses.id), eq(courses.ownerId, ctx.ownerId)))
      .where(eq(announcements.ownerId, ctx.ownerId)).orderBy(desc(announcements.postedAt))),
  };
}
