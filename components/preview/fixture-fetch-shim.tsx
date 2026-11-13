"use client";

import { fixtureFetch } from "./fixture-api";

// DEV-ONLY. Imported solely by app/dev-preview, which returns notFound() unless
// NODE_ENV === "development". Patching happens at module evaluation, before any component
// effect runs, so client components that fetch on mount receive fixture JSON.
declare global { interface Window { __cgFixtureFetch?: boolean } }

if (typeof window !== "undefined" && process.env.NODE_ENV === "development" && !window.__cgFixtureFetch) {
  window.__cgFixtureFetch = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    if (url.origin === window.location.origin && url.pathname.startsWith("/api/")) {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      let body: Record<string, unknown> | null = null;
      try { body = typeof init?.body === "string" ? JSON.parse(init.body) : null; } catch { body = null; }
      const result = fixtureFetch(method, url, body, new Date());
      if (result) {
        await new Promise(resolve => setTimeout(resolve, 60));
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "Not available in fixture preview" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    return original(input, init);
  };
}

export function FixtureFetchShim() { return null; }
