"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function RetryButton({ label = "Try again" }: { label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return <button type="button" className="button secondary" disabled={pending} aria-busy={pending} onClick={() => start(() => router.refresh())}>{pending ? "Retrying…" : label}</button>;
}
