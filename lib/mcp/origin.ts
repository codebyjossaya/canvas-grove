// Public origin of Grove for MCP/OAuth URLs (issuer, resource, metadata links). Never hardcoded:
//   1. GROVE_PUBLIC_ORIGIN, when set to a valid http(s) origin, always wins. SET THIS IN
//      PRODUCTION so the OAuth issuer cannot vary with request headers.
//   2. Otherwise, if GROVE_ALLOWED_HOSTS (comma-separated hosts, optional :port) is set, only a
//      host on that list is accepted from x-forwarded-host / Host; any other host gets the first
//      listed host (https).
//   3. With neither set (dev), x-forwarded-proto / x-forwarded-host (first value), then Host, then
//      the request URL are used as before, and a one-time warning is logged. Malformed hosts are
//      always rejected.
// Pure module.

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9a-f:.]{2,45}\\])(?::(\\d{1,5}))?$`, "i");

const first = (value: string | null) => value?.split(",")[0]?.trim() || null;

export function validHost(host: string | null): host is string {
  if (!host || host.length > 260) return false;
  const match = HOST.exec(host);
  return !!match && (match[1] === undefined || (Number(match[1]) > 0 && Number(match[1]) <= 65535));
}

export function envOrigin(value: string | undefined = process.env.GROVE_PUBLIC_ORIGIN): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && validHost(url.host) ? url.origin : null;
  } catch { return null; }
}

export function allowedHosts(value: string | undefined = process.env.GROVE_ALLOWED_HOSTS): string[] {
  return (value ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(validHost);
}

let warned = false;

export function publicOrigin(headers: Headers, fallback: string | null, env: string | undefined = process.env.GROVE_PUBLIC_ORIGIN, allow: string[] = allowedHosts()): string | null {
  const configured = envOrigin(env);
  if (configured) return configured;
  if (!allow.length && !warned) {
    warned = true;
    console.warn("mcp_origin: GROVE_PUBLIC_ORIGIN and GROVE_ALLOWED_HOSTS are unset; the OAuth issuer is derived from request headers. Set GROVE_PUBLIC_ORIGIN in production.");
  }
  let fallbackUrl: URL | null = null;
  try { fallbackUrl = fallback ? new URL(fallback) : null; } catch { fallbackUrl = null; }
  const forwardedProto = first(headers.get("x-forwarded-proto"))?.toLowerCase();
  const proto = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : fallbackUrl?.protocol === "https:" ? "https" : "http";
  for (const host of [first(headers.get("x-forwarded-host")), first(headers.get("host"))]) {
    if (!validHost(host)) continue;
    if (allow.length && !allow.includes(host.toLowerCase())) return `https://${allow[0]}`;
    return `${proto}://${host.toLowerCase()}`;
  }
  if (allow.length) return `https://${allow[0]}`;
  return fallbackUrl && validHost(fallbackUrl.host) ? fallbackUrl.origin : null;
}

export const mcpServerUrl = (origin: string) => `${origin}/mcp`;
export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource`;
