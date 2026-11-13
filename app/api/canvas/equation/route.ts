import { auth } from "@clerk/nextjs/server";
import { ensureUserForClerk } from "@/lib/db/auth-context";
import { proxyEquationImage, proxyErrorResponse } from "@/lib/canvas/file-proxy";

export const instant = false;

/** Canvas equation image (`?p=/equation_images/...`), fetched server-side and streamed back. */
export async function GET(request: Request) {
  const session = await auth();
  if (!session.userId) return Response.json({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401 });
  try {
    const path = new URL(request.url).searchParams.get("p") ?? "";
    return await proxyEquationImage(await ensureUserForClerk(session.userId), path, request.headers.get("if-none-match"));
  } catch (error) { return proxyErrorResponse(error); }
}
