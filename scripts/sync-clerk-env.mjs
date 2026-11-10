import { readFile, writeFile } from "node:fs/promises";

const parse = (text) => new Map(text.split(/\r?\n/).filter((line) => line && !line.startsWith("#") && line.includes("=")).map((line) => {
  const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
}));
const source = parse(await readFile(".env.local", "utf8"));
let target = await readFile(".env.docker", "utf8");
for (const key of ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"]) {
  const value = source.get(key);
  if (!value) throw new Error(`${key} is missing from .env.local`);
  target = target.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
}
await writeFile(".env.docker", target, { encoding: "utf8", mode: 0o600 });
console.log("Copied Clerk configuration into .env.docker without printing values.");
