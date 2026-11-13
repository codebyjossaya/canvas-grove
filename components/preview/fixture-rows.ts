import type { AnnouncementRow, AssignmentRow, ConversationRow, CourseRow, MessageRow, PlannerRow, SubmissionRow, WorkspaceRows } from "@/lib/views/types";

// DEV-ONLY fixture rows for the /dev-preview route. Shapes match lib/db/schema.ts columns; all
// times are relative to `now` so every surface (overdue, today, this week, digest) has content.
// Nothing here is reachable in production builds.

export const FIXTURE_ORIGIN = "https://canvas.example.edu";
export const FIXTURE_ZONE = "America/New_York";

const uuid = (prefix: number, index: number) => `00000000-0000-4000-8${String(prefix).padStart(3, "0")}-${String(index).padStart(12, "0")}`;
export const COURSE_IDS = { mar: uuid(1, 1), sta: uuid(1, 2), dig: uuid(1, 3), enc: uuid(1, 4), bsc: uuid(1, 5), amh: uuid(1, 6), psy: uuid(1, 7) };

export const fixtureCourses: CourseRow[] = [
  { id: COURSE_IDS.mar, name: "Principles of Marketing", courseCode: "MAR 3023", termName: "Fall 2026", currentScore: "84.21", currentGrade: "B", favorite: true, canvasCourseId: "48211" },
  { id: COURSE_IDS.sta, name: "Introduction to Statistics", courseCode: "STA 2023", termName: "Fall 2026", currentScore: "91.6", currentGrade: "A-", favorite: true, canvasCourseId: "48302" },
  { id: COURSE_IDS.dig, name: "Designing Interactive Experiences", courseCode: "DIG 3878", termName: "Fall 2026", currentScore: "88.05", currentGrade: "B+", favorite: true, canvasCourseId: "48417" },
  { id: COURSE_IDS.enc, name: "Professional Communication", courseCode: "ENC 3254", termName: "Fall 2026", currentScore: "95.1", currentGrade: "A", favorite: true, canvasCourseId: "48530" },
  { id: COURSE_IDS.bsc, name: "Integrated Principles of Biology 1", courseCode: "BSC 2010", termName: "Fall 2026", currentScore: null, currentGrade: null, favorite: true, canvasCourseId: "48644" },
  { id: COURSE_IDS.amh, name: "United States History to 1877", courseCode: "AMH 2010", termName: "Spring 2026", currentScore: "89.4", currentGrade: "B+", favorite: false, canvasCourseId: "41120" },
  { id: COURSE_IDS.psy, name: "General Psychology", courseCode: "PSY 2012", termName: "Spring 2026", currentScore: "93.0", currentGrade: "A", favorite: false, canvasCourseId: "41233" },
];

type Spec = { course: keyof typeof COURSE_IDS; name: string; due: number | null; hour?: number; points: number | null; types?: string[]; group?: string; sub?: Partial<SubmissionRow> & { gradedAgoHours?: number; submittedAgoHours?: number } };

// due = days from today (fractional allowed); hour = local hour of the due time.
const specs: Spec[] = [
  { course: "sta", name: "Homework 7: Sampling Distributions", due: -2, hour: 23.98, points: 20, group: "hw" },
  { course: "dig", name: "Usability test plan draft", due: -1, hour: 17, points: 50, group: "proj", sub: { missing: true } },
  { course: "mar", name: "Chapter 9 reading quiz", due: 0, hour: 9, points: 10, types: ["online_quiz"], group: "quiz" },
  { course: "mar", name: "Case study: Patagonia positioning", due: 0, hour: 23.98, points: 40, group: "case" },
  { course: "enc", name: "Memo revision", due: 0, hour: 17, points: 25, group: "writing", sub: { state: "submitted", submittedAgoHours: 3 } },
  { course: "sta", name: "Lab 8: Confidence intervals in R", due: 1, hour: 23.98, points: 30, group: "lab" },
  { course: "bsc", name: "Lab report: Enzyme kinetics", due: 2, hour: 12, points: 40, group: "lab" },
  { course: "dig", name: "Discussion: Heuristics in the wild", due: 2, hour: 23.98, points: 10, types: ["discussion_topic"], group: "disc" },
  { course: "enc", name: "Cover letter workshop reflection", due: 3, hour: 23.98, points: 15, group: "writing" },
  { course: "mar", name: "Chapter 10 reading quiz", due: 5, hour: 9, points: 10, types: ["online_quiz"], group: "quiz" },
  { course: "sta", name: "Midterm 2", due: 6, hour: 14, points: 100, types: ["on_paper"], group: "exam" },
  { course: "bsc", name: "Mastering Biology: Chapter 8", due: 6, hour: 23.98, points: 12, types: ["external_tool"], group: "hw" },
  { course: "dig", name: "Prototype v2 critique", due: 7, hour: 13, points: 60, group: "proj" },
  { course: "mar", name: "Group project milestone 3", due: 11, hour: 23.98, points: 100, group: "proj" },
  { course: "enc", name: "Formal report proposal", due: 13, hour: 23.98, points: 50, group: "writing" },
  { course: "sta", name: "Homework 8: Hypothesis tests", due: 9, hour: 23.98, points: 20, group: "hw" },
  // Graded history (drives grades, digest and what-if).
  { course: "mar", name: "Chapter 8 reading quiz", due: -6, hour: 9, points: 10, types: ["online_quiz"], group: "quiz", sub: { state: "graded", score: "8", grade: "8", gradedAgoHours: 20 } },
  { course: "mar", name: "Case study: Warby Parker", due: -9, hour: 23.98, points: 40, group: "case", sub: { state: "graded", score: "34", grade: "34", gradedAgoHours: 30 } },
  { course: "mar", name: "Chapter 7 reading quiz", due: -13, hour: 9, points: 10, types: ["online_quiz"], group: "quiz", sub: { state: "graded", score: "9", grade: "9", gradedAgoHours: 280 } },
  { course: "mar", name: "Chapter 6 reading quiz", due: -20, hour: 9, points: 10, types: ["online_quiz"], group: "quiz", sub: { state: "graded", score: "6", grade: "6", gradedAgoHours: 450 } },
  { course: "mar", name: "Group project milestone 2", due: -16, hour: 23.98, points: 100, group: "proj", sub: { state: "graded", score: "86", grade: "86", gradedAgoHours: 300 } },
  { course: "mar", name: "Group project milestone 1", due: -40, hour: 23.98, points: 100, group: "proj", sub: { state: "graded", score: "81", grade: "81", gradedAgoHours: 900, late: true } },
  { course: "mar", name: "Midterm exam", due: -25, hour: 14, points: 100, types: ["on_paper"], group: "exam", sub: { state: "graded", score: "79", grade: "79", gradedAgoHours: 520 } },
  { course: "mar", name: "Participation: weeks 1–6", due: -30, hour: 23.98, points: 20, types: ["none"], group: "part", sub: { state: "graded", score: "20", grade: "20", gradedAgoHours: 700 } },
  { course: "sta", name: "Homework 6: Normal models", due: -9, hour: 23.98, points: 20, group: "hw", sub: { state: "graded", score: "19", grade: "19", gradedAgoHours: 6 } },
  { course: "sta", name: "Lab 7: Bootstrapping", due: -8, hour: 23.98, points: 30, group: "lab", sub: { state: "graded", score: "28", grade: "28", gradedAgoHours: 40 } },
  { course: "dig", name: "Persona research", due: -12, hour: 23.98, points: 50, group: "proj", sub: { state: "graded", score: "44", grade: "44", gradedAgoHours: 15 } },
  { course: "enc", name: "Memo first draft", due: -10, hour: 17, points: 25, group: "writing", sub: { state: "graded", score: "24", grade: "24", gradedAgoHours: 100 } },
  { course: "bsc", name: "Lab safety quiz", due: -50, hour: 23.98, points: 5, types: ["online_quiz"], group: "quiz", sub: { state: "graded", score: "5", grade: "5", gradedAgoHours: 1100 } },
];

const groupNames: Record<string, [string, number]> = { hw: ["Homework", 20], lab: ["Labs", 15], quiz: ["Reading quizzes", 15], case: ["Case studies", 25], proj: ["Projects", 35], exam: ["Exams", 25], part: ["Participation", 0], writing: ["Writing assignments", 60], disc: ["Discussions", 10] };

export function fixtureGroupId(course: string, group: string) { return `${COURSE_IDS[course as keyof typeof COURSE_IDS]}:${group}`; }
export function fixtureGroups(courseId: string) {
  const course = Object.entries(COURSE_IDS).find(([, id]) => id === courseId)?.[0];
  const keys = [...new Set(specs.filter(spec => spec.course === course).map(spec => spec.group ?? "hw"))];
  return keys.map((key, index) => ({ id: fixtureGroupId(course!, key), name: groupNames[key][0], weight: groupNames[key][1], position: index, dropLowest: key === "quiz" ? 1 : 0, dropHighest: 0, neverDropCanvasIds: [] as string[] }));
}

/** A local wall-clock time in FIXTURE_ZONE, `days` from today. Good enough for previews (ignores DST edges). */
function localTime(now: Date, days: number, hour: number) {
  const offset = zoneOffsetMinutes(now, FIXTURE_ZONE);
  const local = new Date(now.getTime() + offset * 60_000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(midnight + days * 86_400_000 + Math.round(hour * 60) * 60_000 - offset * 60_000);
}
function zoneOffsetMinutes(at: Date, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return Math.round((Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - at.getTime()) / 60_000);
}

export function fixtureRows(now: Date): WorkspaceRows & { messages: MessageRow[] } {
  const assignments: AssignmentRow[] = [], submissions: SubmissionRow[] = [];
  specs.forEach((spec, index) => {
    const id = uuid(2, index + 1);
    const dueAt = spec.due == null ? null : localTime(now, spec.due, spec.hour ?? 23.98).toISOString();
    assignments.push({ id, courseId: COURSE_IDS[spec.course], name: spec.name, dueAt, pointsPossible: spec.points == null ? null : String(spec.points), submissionTypes: spec.types ?? ["online_upload"], workflowState: "published", canvasAssignmentId: String(900100 + index), assignmentGroupId: fixtureGroupId(spec.course, spec.group ?? "hw") });
    if (spec.sub) {
      const { gradedAgoHours, submittedAgoHours, ...rest } = spec.sub;
      const gradedAt = gradedAgoHours != null ? new Date(now.getTime() - gradedAgoHours * 3_600_000).toISOString() : null;
      const submittedAt = submittedAgoHours != null ? new Date(now.getTime() - submittedAgoHours * 3_600_000).toISOString() : gradedAt ? new Date(new Date(dueAt ?? now).getTime() - 3_600_000).toISOString() : null;
      submissions.push({ assignmentId: id, attempt: 1, state: null, submittedAt, gradedAt, score: null, grade: null, late: false, missing: false, excused: false, ...rest });
    }
  });
  const planner: PlannerRow[] = [
    { id: uuid(3, 1), courseId: COURSE_IDS.sta, assignmentId: null, source: "canvas", kind: "calendar_event", title: "Office hours with Dr. Alvarez", startsAt: localTime(now, 1, 15).toISOString(), dueAt: null, status: "todo", canvasItemType: "calendar_event" },
    { id: uuid(3, 2), courseId: COURSE_IDS.bsc, assignmentId: null, source: "canvas", kind: "calendar_event", title: "Exam 2 review session", startsAt: localTime(now, 4, 18).toISOString(), dueAt: null, status: "todo", canvasItemType: "calendar_event" },
    { id: uuid(3, 3), courseId: COURSE_IDS.dig, assignmentId: null, source: "canvas", kind: "wiki_page", title: "Read: Nielsen’s 10 heuristics", startsAt: null, dueAt: localTime(now, 1, 10).toISOString(), status: "todo", canvasItemType: "wiki_page" },
    { id: uuid(3, 4), courseId: null, assignmentId: null, source: "canvas", kind: "planner_note", title: "Advising appointment", startsAt: null, dueAt: localTime(now, 3, 11).toISOString(), status: "todo", canvasItemType: "planner_note" },
  ];
  const announcements: AnnouncementRow[] = [
    { id: uuid(4, 1), courseId: COURSE_IDS.sta, title: "Midterm 2 logistics and formula sheet", bodyHtml: "<p>Midterm 2 is next week in our usual room. You may bring one handwritten formula sheet (front and back).</p><p>Topics: sampling distributions, confidence intervals, and the first half of hypothesis testing. A practice exam is posted under Files &gt; Exams.</p><ul><li>Bring a calculator</li><li>Arrive 10 minutes early</li></ul>", postedAt: new Date(now.getTime() - 5 * 3_600_000).toISOString(), htmlUrl: `${FIXTURE_ORIGIN}/courses/48302/discussion_topics/7001` },
    { id: uuid(4, 2), courseId: COURSE_IDS.mar, title: "Guest speaker Thursday: brand strategy at REI", bodyHtml: "<p>We have a guest speaker from REI’s brand team this Thursday. Attendance counts toward participation.</p><p>Come with one question about how they position the co-op against big-box competitors.</p>", postedAt: new Date(now.getTime() - 26 * 3_600_000).toISOString(), htmlUrl: `${FIXTURE_ORIGIN}/courses/48211/discussion_topics/7002` },
    { id: uuid(4, 3), courseId: COURSE_IDS.dig, title: "Studio moved to the media lab this week", bodyHtml: "<p>Wednesday studio meets in the media lab (room 214) so we can run moderated usability sessions.</p>", postedAt: new Date(now.getTime() - 50 * 3_600_000).toISOString(), htmlUrl: `${FIXTURE_ORIGIN}/courses/48417/discussion_topics/7003` },
    { id: uuid(4, 4), courseId: COURSE_IDS.bsc, title: "Lab sections: enzyme kinetics data posted", bodyHtml: "<p>Class data from the enzyme kinetics lab is now in Files. Use the combined dataset for your report.</p>", postedAt: new Date(now.getTime() - 6 * 86_400_000).toISOString(), htmlUrl: `${FIXTURE_ORIGIN}/courses/48644/discussion_topics/7004` },
    { id: uuid(4, 5), courseId: COURSE_IDS.enc, title: "Peer review pairs for the memo revision", bodyHtml: "<p>Peer review pairs are posted. Exchange drafts by Friday.</p>", postedAt: new Date(now.getTime() - 9 * 86_400_000).toISOString(), htmlUrl: `${FIXTURE_ORIGIN}/courses/48530/discussion_topics/7005` },
  ];
  const person = (id: number, name: string) => ({ id, name });
  const conversations: ConversationRow[] = [
    { id: uuid(5, 1), courseId: COURSE_IDS.dig, subject: "Feedback on your persona research", workflowState: "unread", lastMessageAt: new Date(now.getTime() - 2 * 3_600_000).toISOString(), messageCount: 2, starred: false, participants: [person(1, "Prof. Dana Whitfield"), person(2, "Jordan Lee")] },
    { id: uuid(5, 2), courseId: COURSE_IDS.mar, subject: "Group project: milestone 3 split", workflowState: "unread", lastMessageAt: new Date(now.getTime() - 19 * 3_600_000).toISOString(), messageCount: 4, starred: true, participants: [person(3, "Priya Natarajan"), person(4, "Marcus Bell"), person(5, "Sofia Reyes"), person(2, "Jordan Lee")] },
    { id: uuid(5, 3), courseId: COURSE_IDS.sta, subject: "Re: Lab 7 regrade request", workflowState: "read", lastMessageAt: new Date(now.getTime() - 4 * 86_400_000).toISOString(), messageCount: 3, starred: false, participants: [person(6, "Ana Alvarez (TA)"), person(2, "Jordan Lee")] },
  ];
  const messages: MessageRow[] = [
    { id: uuid(6, 1), conversationId: uuid(5, 1), authorName: "Jordan Lee", bodyHtml: "<p>Hi Professor, could you share any feedback on the persona research before I start the usability plan?</p>", sentAt: new Date(now.getTime() - 30 * 3_600_000).toISOString(), attachments: [] },
    { id: uuid(6, 2), conversationId: uuid(5, 1), authorName: "Prof. Dana Whitfield", bodyHtml: "<p>Nice work overall, Jordan. Your interview synthesis is strong.</p><p>For the usability plan, narrow to two primary tasks and write success criteria for each. I left comments on the rubric in Canvas.</p>", sentAt: new Date(now.getTime() - 2 * 3_600_000).toISOString(), attachments: [{ display_name: "persona-rubric-comments.pdf", url: `${FIXTURE_ORIGIN}/files/55/download` }] },
    { id: uuid(6, 3), conversationId: uuid(5, 2), authorName: "Priya Natarajan", bodyHtml: "<p>I can take the competitive analysis section. Marcus, can you do the pricing slides?</p>", sentAt: new Date(now.getTime() - 22 * 3_600_000).toISOString(), attachments: [] },
    { id: uuid(6, 4), conversationId: uuid(5, 2), authorName: "Sofia Reyes", bodyHtml: "<p>I’ll handle the survey data and the appendix. Can we meet Wednesday at 4?</p>", sentAt: new Date(now.getTime() - 19 * 3_600_000).toISOString(), attachments: [] },
    { id: uuid(6, 5), conversationId: uuid(5, 3), authorName: "Ana Alvarez (TA)", bodyHtml: "<p>I re-checked part (c) and updated your score to 28/30.</p>", sentAt: new Date(now.getTime() - 4 * 86_400_000).toISOString(), attachments: [] },
  ];
  return { canvasOrigin: FIXTURE_ORIGIN, courses: fixtureCourses, assignments, submissions, planner, announcements, conversations, messages };
}
