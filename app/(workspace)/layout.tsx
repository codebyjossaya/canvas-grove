import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { Suspense, type ReactNode } from "react";
import { AppShell } from "@/components/ui/app-shell";
import { SidebarCourseList } from "@/components/ui/side-nav";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { loadSidebarCourses } from "@/lib/views/loaders";

// Shared by every signed-in workspace route. Because this layout persists across client
// navigations, the sidebar, palette, sync status and account menu stay mounted and only the
// page column below re-renders. Each page still performs its own auth and onboarding checks.
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <AppShell courses={<Suspense fallback={null}><SidebarCourses /></Suspense>} user={<UserButton appearance={{ elements: { avatarBox: "avatar" } }} />}>{children}</AppShell>;
}

async function SidebarCourses() {
  const session = await auth();
  if (!session.userId) return null;
  let courses;
  try {
    courses = await loadSidebarCourses(await ensureUserForClerk(session.userId));
  } catch {
    return null; // The sidebar course list is a shortcut; pages still load their own data.
  }
  return <SidebarCourseList courses={courses} />;
}
