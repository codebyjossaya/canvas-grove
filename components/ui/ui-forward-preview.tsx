"use client";

import { useSearchParams } from "next/navigation";
import { CourseWorkspace } from "./course-workspace";
import { GradeCoursePicker } from "./grade-course-picker";
import { GradesWorkspace } from "./grades-workspace";
import { QuizHub } from "./quiz-hub";
import { QuizMode } from "./quiz-mode";
import { CanvasSessionManager } from "./canvas-session";
import { SecureBrowserPopup } from "./secure-browser-popup";
import { CoursesScreen } from "@/components/workspace/courses-screen";
import { FIXTURE_ZONE, fixtureRows } from "@/components/preview/fixture-rows";
import { buildCourses } from "@/lib/views/build";

export function UiForwardPreview() {
  const mode = useSearchParams().get("mode") ?? "course";
  if (mode === "course") return <CourseWorkspace courseId="course-1" />;
  if (mode === "files" || mode === "syllabus" || mode === "modules" || mode === "pages" || mode === "course-grades") return <CourseWorkspace courseId="course-1" active={mode === "course-grades" ? "grades" : mode} />;
  if (mode === "grades") return <GradesWorkspace courseId="course-1" />;
  if (mode === "grade-picker") return <GradeCoursePicker courses={pickerCourses} />;
  if (mode === "quizzes") return <main className="dashboard route-page"><header className="dashboard-head"><div><p className="eyebrow">Quiz mode</p><h1>Focus on the questions.</h1><p>A native quiz workspace with explicit starts, autosave, review, and final submission.</p></div></header><QuizHub /></main>;
  if (mode === "quiz") return <QuizMode quizId="quiz-1" />;
  if (mode === "auth-session") return <main className="dashboard route-page"><CanvasSessionManager /></main>;
  if (mode === "auth-popup") return <SecureBrowserPopup sessionId="preview-session" />;
  return <CourseHubPreview />;
}

// The old course-hub mock was replaced by the redesigned CoursesScreen; render it from dev fixtures.
function CourseHubPreview() {
  const now = new Date();
  return <CoursesScreen view={buildCourses(fixtureRows(now), now, FIXTURE_ZONE, "active")} />;
}

const pickerCourses = [
  { id: "course-1", name: "Principles of Marketing", courseCode: "MAR 3023", termName: "Fall 2026", currentGrade: "B", currentScore: 84.2, favorite: true },
  { id: "course-2", name: "Designing Interactive Experiences", courseCode: "DIG 3878", termName: "Fall 2026", currentGrade: "A−", currentScore: 91.4, favorite: true },
  { id: "course-3", name: "Introduction to Statistics", courseCode: "STA 2023", termName: "Fall 2026", currentGrade: null, currentScore: null, favorite: true },
  { id: "course-4", name: "Professional Communication", courseCode: "ENC 3254", termName: "Fall 2026", currentGrade: "A", currentScore: 94.7, favorite: false },
];
