// Row shapes the view builders accept. They mirror lib/db/schema.ts columns (timestamps may be
// Date objects from Drizzle or ISO strings from fixtures/JSON), so the same pure builders serve
// the real loaders and the dev-only fixture preview.
export type Instant = Date | string | null | undefined;

export type CourseRow = {
  id: string; name: string; courseCode: string | null; termName: string | null; workflowState?: string | null;
  currentScore: string | number | null; currentGrade: string | null; favorite: boolean; canvasCourseId: string;
};
export type AssignmentRow = {
  id: string; courseId: string; name: string; dueAt: Instant; pointsPossible: string | number | null;
  submissionTypes: string[]; workflowState: string | null; canvasAssignmentId: string; assignmentGroupId?: string | null;
  /** Optional Canvas identity/availability details (from source_payload). Older fixtures omit them. */
  htmlUrl?: string | null; quizId?: string | null; discussionTopicId?: string | null;
  /** Canvas payload "type": calendar-event rows mirrored into assignments carry "event". */
  sourceType?: string | null;
  unlockAt?: Instant; lockAt?: Instant; lockedForUser?: boolean | null; inClosedGradingPeriod?: boolean | null;
};
export type SubmissionRow = {
  assignmentId: string; attempt: number; state: string | null; submittedAt: Instant; gradedAt: Instant;
  score: string | number | null; grade: string | null; late: boolean; missing: boolean; excused: boolean;
};
export type PlannerRow = {
  id: string; courseId: string | null; assignmentId: string | null; source: "app" | "canvas"; kind: string; title: string;
  startsAt: Instant; dueAt: Instant; status: "todo" | "in_progress" | "completed" | "cancelled"; canvasItemType: string | null;
  canvasItemId?: string | null;
};
export type AnnouncementRow = { id: string; courseId: string | null; title: string; bodyHtml: string | null; postedAt: Instant; htmlUrl: string | null };
export type ConversationRow = {
  id: string; courseId: string | null; subject: string | null; workflowState: string | null; lastMessageAt: Instant;
  messageCount: number; starred: boolean; participants: unknown;
};
export type MessageRow = { id: string; conversationId: string; authorName: string | null; bodyHtml: string | null; sentAt: Instant; attachments: unknown };
/** custom_events row: the student's own event. Timed events use startsAt/endsAt, all-day ones startDate/endDate. */
export type CustomEventRow = {
  id: string; courseId: string | null; title: string; notes: string | null; allDay: boolean;
  startsAt: Instant; endsAt: Instant; startDate: string | null; endDate: string | null; color: number;
};

/** Everything the workspace views are derived from. */
export type WorkspaceRows = {
  canvasOrigin: string | null;
  courses: CourseRow[];
  assignments: AssignmentRow[];
  submissions: SubmissionRow[];
  planner: PlannerRow[];
  announcements: AnnouncementRow[];
  conversations: ConversationRow[];
};

// ---------------------------------------------------------------------------------------------
// View models (plain JSON, safe to pass from server to client components)

export type CourseRef = { id: string; name: string; code: string; color: number };

export type WorkState = "open" | "overdue" | "submitted" | "graded" | "missing" | "late" | "excused" | "done" | "past";
export type WorkKind = "assignment" | "quiz" | "discussion" | "event" | "note" | "page" | "other";

export type WorkItem = {
  id: string; kind: WorkKind; title: string; course: CourseRef | null;
  dueAt: string | null; allDay: boolean; points: number | null; state: WorkState;
  score: number | null; href: string | null; canvasUrl: string | null;
  /** True when Canvas no longer accepts a submission (locked, closed grading period, not submittable). */
  closed?: boolean;
};

/** A custom (Grove-only) event as the planner shows it. Never a Canvas item: it has no href or state. */
export type CustomEventItem = {
  id: string; title: string; notes: string | null; course: CourseRef | null; color: number; allDay: boolean;
  startsAt: string | null; endsAt: string | null; startDate: string | null; endDate: string | null;
};

/** `custom` is set only by the planner, which merges the student's own events into its days. */
export type DayGroup = { key: string; label: string; sublabel: string; items: WorkItem[]; custom?: CustomEventItem[] };

export type DigestEntry =
  | { kind: "announcement"; id: string; title: string; course: CourseRef | null; at: string; href: string }
  | { kind: "message"; id: string; title: string; from: string; course: CourseRef | null; at: string; href: string; unread: boolean }
  | { kind: "grade"; id: string; title: string; course: CourseRef | null; at: string; href: string; score: number | null; points: number | null; grade: string | null };

export type TodayView = {
  now: string; zone: string; greetingName: string | null;
  overdue: WorkItem[]; today: WorkItem[]; week: DayGroup[]; laterCount: number;
  digest: { since: string; sinceLabel: string; firstVisit: boolean; entries: DigestEntry[] };
  courses: Array<CourseRef & { grade: string | null; score: number | null; dueThisWeek: number }>;
  hasAnyData: boolean;
};

export type WorkloadDay = { key: string; weekday: string; day: string; count: number; points: number; today: boolean };

export type PlannerView = {
  now: string; zone: string; view: "week" | "agenda";
  weekStart: string; weekLabel: string; prevWeek: string; nextWeek: string; thisWeek: string; isCurrentWeek: boolean;
  days: Array<DayGroup & { today: boolean; weekday: string; dayNumber: string }>;
  agenda: DayGroup[]; undated: WorkItem[];
  workload: WorkloadDay[];
  hasAnyData: boolean;
  /** Courses the event form can link to. */
  courses: CourseRef[];
};

export type InboxThread = {
  id: string; subject: string; participants: string; initials: string; course: CourseRef | null;
  lastAt: string | null; count: number; unread: boolean; starred: boolean; preview: string;
};
export type InboxMessage = { id: string; author: string; initials: string; at: string | null; paragraphs: string[]; attachments: Array<{ name: string; url: string | null }> };
export type InboxAnnouncement = { id: string; title: string; course: CourseRef | null; at: string | null; preview: string; paragraphs: string[]; canvasUrl: string | null };

export type InboxView = {
  zone: string; tab: "messages" | "announcements"; canvasInboxUrl: string | null;
  threads: InboxThread[]; announcements: InboxAnnouncement[];
  selectedThread: (InboxThread & { messages: InboxMessage[] }) | null;
  selectedAnnouncement: InboxAnnouncement | null;
};

export type CourseCard = CourseRef & {
  term: string | null; grade: string | null; score: number | null; favorite: boolean;
  next: WorkItem | null; dueThisWeek: number; missing: number;
};
export type CoursesView = { view: "active" | "inactive"; active: CourseCard[]; inactive: CourseCard[]; zone: string; now: string };

export type GradesOverviewCourse = CourseRef & { term: string | null; grade: string | null; score: number | null; favorite: boolean; graded: number; missing: number };
export type RecentGrade = { id: string; title: string; course: CourseRef; gradedAt: string; score: number | null; points: number | null; grade: string | null };

export type PaletteIndex = {
  courses: Array<CourseRef & { favorite: boolean }>;
  items: Array<{ id: string; title: string; course: CourseRef | null; dueAt: string | null; href: string | null; canvasUrl: string | null; state: WorkState }>;
};

export type SidebarCourse = CourseRef & { favorite: boolean };
