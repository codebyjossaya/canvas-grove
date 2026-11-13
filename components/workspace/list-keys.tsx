"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useNavBase, withBase } from "@/components/ui/app-link";

/** J/K move through a server-rendered list of links (inbox threads, announcements). */
export function ListKeys({ hrefs, current }: { hrefs: string[]; current: string | null }) {
  const router = useRouter();
  const base = useNavBase();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)))) return;
      if (event.key !== "j" && event.key !== "k") return;
      if (!hrefs.length) return;
      const index = current ? hrefs.indexOf(current) : -1;
      const next = event.key === "j" ? Math.min(hrefs.length - 1, index + 1) : Math.max(0, index - 1);
      if (next !== index) { event.preventDefault(); router.push(withBase(base, hrefs[next]), { scroll: false }); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [base, current, hrefs, router]);
  return null;
}
