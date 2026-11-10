import { isIP } from "node:net";

function ipv4Number(value: string): number {
  return value.split(".").reduce((result, octet) => (result << 8) + Number(octet), 0) >>> 0;
}

function inV4Range(value: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(value) & mask) === (ipv4Number(base) & mask);
}

export function isPublicAddress(value: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) return isPublicAddress(mapped[1]);
  const family = isIP(value);
  if (family === 4) return ![
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 4], ["240.0.0.0", 4],
  ].some(([base, bits]) => inV4Range(value, String(base), Number(bits)));
  if (family === 6) {
    const normalized = value.toLowerCase();
    return normalized !== "::" && normalized !== "::1" && !normalized.startsWith("fc") && !normalized.startsWith("fd") &&
      !/^fe[89ab]/.test(normalized) && !normalized.startsWith("ff") && !normalized.startsWith("2001:db8:");
  }
  return false;
}
