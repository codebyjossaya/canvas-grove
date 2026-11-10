"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CourseWorkspace } from "./course-workspace";
import { GradeCoursePicker } from "./grade-course-picker";
import { GradesWorkspace } from "./grades-workspace";
import { QuizHub } from "./quiz-hub";
import { QuizMode } from "./quiz-mode";
import { CanvasSessionManager } from "./canvas-session";
import { SecureBrowserPopup } from "./secure-browser-popup";
import courseStyles from "@/app/(workspace)/courses/courses.module.css";

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

function CourseHubPreview() {
  const courses = [
    { id: "1", code: "MAR 3023", name: "Principles of Marketing", term: "Fall 2026", grade: "B" },
    { id: "2", code: "DIG 3878", name: "Designing Interactive Experiences", term: "Fall 2026", grade: "A−" },
    { id: "3", code: "STA 2023", name: "Introduction to Statistics", term: "Fall 2026", grade: "Not posted" },
    { id: "4", code: "ENC 3254", name: "Professional Communication", term: "Fall 2026", grade: "A" },
  ];
  return <main className="dashboard route-page"><header className={`dashboard-head ${courseStyles.heading}`}><div><p className="eyebrow">Courses</p><h1>Your learning spaces.</h1><p>Open a course, find its materials, or keep past classes close by.</p></div><div className={courseStyles.summary}><span><strong>4</strong> active</span><i /><span><strong>16</strong> synced</span></div></header><nav className={courseStyles.tabs}><Link href="#" aria-current="page">Active <span>4</span></Link><Link href="#">Inactive <span>12</span></Link></nav><section className={courseStyles.grid}>{courses.map((course, index) => <article className={courseStyles.card} key={course.id} style={{ "--course-hue": String((index * 47 + 118) % 360) } as React.CSSProperties}><div className={courseStyles.cardTop}><span className={courseStyles.courseMark}>{course.code.slice(0, 2)}</span><button className="button secondary" aria-label={`Deactivate ${course.name}`}>Active</button></div><Link className={courseStyles.cardLink} href="#"><span className={courseStyles.code}>{course.code}</span><h2>{course.name}</h2><span className={courseStyles.term}>{course.term}</span><span className={courseStyles.open}>Open course <b>→</b></span></Link><div className={courseStyles.cardFoot}><span>Current grade</span><strong>{course.grade}</strong></div></article>)}</section></main>;
}

const pickerCourses = [
  { id: "course-1", name: "Principles of Marketing", courseCode: "MAR 3023", termName: "Fall 2026", currentGrade: "B", currentScore: 84.2, favorite: true },
  { id: "course-2", name: "Designing Interactive Experiences", courseCode: "DIG 3878", termName: "Fall 2026", currentGrade: "A−", currentScore: 91.4, favorite: true },
  { id: "course-3", name: "Introduction to Statistics", courseCode: "STA 2023", termName: "Fall 2026", currentGrade: null, currentScore: null, favorite: true },
  { id: "course-4", name: "Professional Communication", courseCode: "ENC 3254", termName: "Fall 2026", currentGrade: "A", currentScore: 94.7, favorite: false },
];
