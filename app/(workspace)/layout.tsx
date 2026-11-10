import type { ReactNode } from "react";
import { AppShell } from "@/components/ui/app-shell";

// Shared by every signed-in workspace route. Because this layout persists across client
// navigations, the sidebar, top bar, sync status and account menu stay mounted and only the
// page column below re-renders. Each page still performs its own auth and onboarding checks.
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
