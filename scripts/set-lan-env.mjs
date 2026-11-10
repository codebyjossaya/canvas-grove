import { readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";

const address = process.argv[2];
const port = Number(process.argv[3] ?? 3000);
const publicBaseUrl = process.argv[4] ?? `http://${address}:${port}`;
if (isIP(address) !== 4) throw new Error("A valid LAN IPv4 address is required");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid LAN port");
const parsedPublicBaseUrl = new URL(publicBaseUrl);
if (parsedPublicBaseUrl.protocol !== "https:" && parsedPublicBaseUrl.hostname !== "localhost") {
  throw new Error("The public browser URL must use HTTPS unless it is localhost");
}
let contents = await readFile(".env.docker", "utf8");
const set = (key, value) => {
  const line = `${key}=${value}`;
  contents = new RegExp(`^${key}=.*$`, "m").test(contents) ? contents.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${contents.trimEnd()}\n${line}\n`;
};
set("LAN_PORT", String(port));
set("BROWSER_PUBLIC_BASE_URL", parsedPublicBaseUrl.origin);
await writeFile(".env.docker", contents, { encoding: "utf8", mode: 0o600 });
console.log("Updated LAN publishing configuration without printing private values.");
