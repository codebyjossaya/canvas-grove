"use client";

import { StepFooter, StepHeader } from "./shell";
import styles from "./orientation.module.css";

const OUTLINE = [
  { title: "Choose your school", detail: "So Grove opens your school's own Canvas sign-in." },
  { title: "Install the Grove extension", detail: "It hands your Canvas sign-in to Grove. Your password never leaves the sign-in page." },
  { title: "Choose what Grove can read", detail: "Pick the Canvas areas Grove syncs and what connected agents may do." },
  { title: "Sign in to Canvas", detail: "In a new tab, the way you normally do, including MFA." },
  { title: "Connect an AI agent", detail: "Optional. You can do this later from Settings." },
] as const;

export function StepWelcome({ onNext }: { onNext: () => void }) {
  return <>
    <StepHeader title="Your Canvas, in one calm workspace">
      Grove brings your courses, deadlines, grades and messages into one place. Canvas stays the source of truth: Grove reads from it and never changes a grade.
    </StepHeader>
    <section className={styles.section} aria-labelledby="welcome-outline">
      <h2 id="welcome-outline" className={styles.sectionTitle}>Setup takes about three minutes</h2>
      <ol className={styles.outline}>
        {OUTLINE.map((item) => <li key={item.title}>
          <span className={styles.outlineTitle}>{item.title}</span>
          <span className={styles.outlineDetail}>{item.detail}</span>
        </li>)}
      </ol>
    </section>
    <StepFooter primary={{ label: "Start setup", onClick: onNext, icon: "arrow" }} />
  </>;
}
