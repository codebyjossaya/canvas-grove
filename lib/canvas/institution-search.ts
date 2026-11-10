import { normalizeCanvasOrigin } from "./institution";

/**
 * School-name search backed by Canvas's public, documented account-search
 * endpoint (GET /api/v1/accounts/search). No credentials are sent or needed.
 */
export const CANVAS_ACCOUNT_SEARCH_URL = "https://canvas.instructure.com/api/v1/accounts/search";
export const INSTITUTION_SEARCH_USER_AGENT = "CanvasGrove-Institution-Search/1.0 (server-side school lookup; no credentials)";
export const MAX_INSTITUTION_RESULTS = 10;
const MAX_RESPONSE_BYTES = 256 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

export type InstitutionSearchResult = { name: string; domain: string };
export type InstitutionSearchOptions = { fetch?: typeof fetch; timeoutMs?: number; cache?: boolean };

/** Upstream (Canvas) failure, as opposed to bad user input. Routes map it to 502. */
export class InstitutionSearchUnavailableError extends Error {
  constructor() { super("School search is unavailable right now. Try again, or paste a sign-in link instead."); this.name = "InstitutionSearchUnavailableError"; }
}

const cache = new Map<string, { at: number; value: InstitutionSearchResult[] }>();

/** Trim/collapse a search query; 2–80 characters. Throws a user-facing message otherwise. */
export function normalizeInstitutionQuery(value: unknown): string {
  const query = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (query.length < 2) throw new Error("Type at least two characters of your school's name");
  if (query.length > 80) throw new Error("School search must be 80 characters or fewer");
  return query;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error("School search response was too large"); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Parse Canvas's account-search JSON into safe `{name, domain}` pairs. Exported for tests. */
export function parseAccountSearch(payload: unknown): InstitutionSearchResult[] {
  if (!Array.isArray(payload)) return [];
  const results: InstitutionSearchResult[] = [];
  const seen = new Set<string>();
  for (const entry of payload) {
    if (results.length >= MAX_INSTITUTION_RESULTS) break;
    if (!entry || typeof entry !== "object") continue;
    const { name, domain } = entry as { name?: unknown; domain?: unknown };
    if (typeof name !== "string" || typeof domain !== "string") continue;
    const cleanName = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
    if (!cleanName) continue;
    let host: string;
    try { host = new URL(normalizeCanvasOrigin(domain)).hostname; } catch { continue; }
    const key = `${cleanName.toLowerCase()}\n${host}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ name: cleanName, domain: host });
  }
  return results;
}

export async function searchCanvasInstitutions(rawQuery: unknown, options: InstitutionSearchOptions = {}): Promise<InstitutionSearchResult[]> {
  const query = normalizeInstitutionQuery(rawQuery);
  const useCache = options.cache ?? !options.fetch;
  const key = query.toLowerCase();
  const hit = useCache ? cache.get(key) : undefined;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const doFetch = options.fetch ?? fetch;
  const url = `${CANVAS_ACCOUNT_SEARCH_URL}?name=${encodeURIComponent(query)}`;
  // One 5s budget covers the request and reading the body.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  let payload: unknown;
  try {
    const response = await doFetch(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      headers: { "user-agent": INSTITUTION_SEARCH_USER_AGENT, accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new InstitutionSearchUnavailableError();
    }
    // Canvas may prefix JSON with `while(1);` as JSON-hijacking protection.
    payload = JSON.parse((await readCapped(response, MAX_RESPONSE_BYTES)).replace(/^\s*while\(1\);/, ""));
  } catch { throw new InstitutionSearchUnavailableError(); }
  finally { clearTimeout(timer); }
  const results = parseAccountSearch(payload);
  if (useCache) {
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), value: results });
  }
  return results;
}
