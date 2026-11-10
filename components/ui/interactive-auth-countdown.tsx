"use client";

import { useEffect, useRef, useState } from "react";
import { interactiveAuthTime, type InteractiveAuthTime } from "@/lib/interactive-auth-deadline";
import styles from "./interactive-auth-countdown.module.css";

export function InteractiveAuthCountdown({
  expiresAt,
  surface = "app",
  onExpire,
}: {
  expiresAt: string;
  surface?: "app" | "popup" | "header";
  onExpire?: () => void;
}) {
  // Deliberately render no clock value until the client reads Date.now(). This
  // keeps the server/client tree stable while still using the server deadline.
  const [time, setTime] = useState<InteractiveAuthTime | null>(null);
  const notified = useRef(false);

  useEffect(() => {
    notified.current = false;
    const update = () => {
      const next = interactiveAuthTime(expiresAt);
      setTime(next);
      if (next?.secondsRemaining === 0 && !notified.current) {
        notified.current = true;
        onExpire?.();
      }
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, onExpire]);

  return (
    <div
      className={styles.countdown}
      data-surface={surface}
      data-urgency={time?.urgency ?? "normal"}
      aria-label={time?.accessible ?? "Secure sign-in expiration timer loading"}
    >
      <span className={styles.label}>Time left to finish sign-in</span>
      <time className={styles.time} dateTime={expiresAt}>
        {time?.display ?? "--:--"}
      </time>
      <p className={styles.hint} aria-live="polite" aria-atomic="true">
        {time?.urgency === "expired"
          ? "This sign-in attempt expired. Return to Canvas Grove to start a new one."
          : time?.urgency === "urgent"
            ? "Less than one minute remains. Finish the current institution prompt now."
            : time?.urgency === "warning"
              ? "This secure sign-in closes soon. Your saved Canvas data is unaffected."
              : "Reopening this window does not restart the timer."}
      </p>
    </div>
  );
}
