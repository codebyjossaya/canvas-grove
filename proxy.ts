import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// "/" is the signed-in Today view inside the persistent workspace layout. Signed-out
// visitors get the public landing page at the same URL, without the workspace chrome.
export default clerkMiddleware(async (auth, request) => {
  // MCP OAuth consent page: never framed (clickjacking), never cached, no referrer leak of the query.
  if (request.nextUrl.pathname === "/oauth/authorize") {
    const response = NextResponse.next();
    response.headers.set("x-frame-options", "DENY");
    response.headers.set("content-security-policy", "frame-ancestors 'none'");
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  }
  if (request.nextUrl.pathname !== "/") return;
  const { userId } = await auth();
  if (!userId) return NextResponse.rewrite(new URL("/landing", request.url));
});

export const config = {
  matcher: [
    "/((?!_next|ui-preview|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
