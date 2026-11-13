import { QuizHub } from "@/components/ui/quiz-hub";

export function QuizzesScreen() {
  return <main className="page wide">
    <header className="page-head">
      <div><h1>Quizzes</h1><p>Quiz Mode runs supported Canvas quizzes in a focused, distraction-free view with autosave and explicit start and submit steps.</p></div>
    </header>
    <QuizHub />
  </main>;
}
