import { auth } from "@clerk/nextjs/server";
import { errorJson, json } from "@/lib/bridge/http";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { loadPaletteIndex } from "@/lib/views/loaders";

// Read-only index for the command palette: courses plus recent and upcoming work.
export async function GET() {
  const session = await auth();
  if (!session.userId) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, 401);
  try { return json(await loadPaletteIndex(await ensureUserForClerk(session.userId))); }
  catch (error) { return errorJson(error); }
}
