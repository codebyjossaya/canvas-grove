export type InteractiveAuthUrgency = "normal" | "warning" | "urgent" | "expired";

export type InteractiveAuthTime = {
  secondsRemaining: number;
  urgency: InteractiveAuthUrgency;
  display: string;
  accessible: string;
};

export function interactiveAuthTime(
  expiresAt: string | null | undefined,
  now = Date.now(),
): InteractiveAuthTime | null {
  if (!expiresAt) return null;
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return null;
  const secondsRemaining = Math.max(0, Math.ceil((deadline - now) / 1000));
  const urgency: InteractiveAuthUrgency =
    secondsRemaining === 0
      ? "expired"
      : secondsRemaining <= 60
        ? "urgent"
        : secondsRemaining <= 300
          ? "warning"
          : "normal";
  const minutes = Math.floor(secondsRemaining / 60);
  const seconds = secondsRemaining % 60;
  const display = `${minutes}:${seconds.toString().padStart(2, "0")}`;
  const accessible =
    secondsRemaining === 0
      ? "Secure sign-in time expired"
      : `Secure sign-in expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"} and ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  return { secondsRemaining, urgency, display, accessible };
}

export function shouldShowInteractiveAuthDeadline(input: {
  state: string;
  interactiveAuthExpiresAt?: string | null;
}) {
  return (
    (input.state === "provisioning" || input.state === "awaiting-login") &&
    Boolean(input.interactiveAuthExpiresAt)
  );
}
