import { randomBytes } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const target = resolve(process.cwd(), ".env.docker");
try {
  await access(target, constants.F_OK);
  console.error(".env.docker already exists; refusing to overwrite it.");
  process.exit(1);
} catch {}

const hex = (bytes = 32) => randomBytes(bytes).toString("hex");
const base64 = (bytes = 32) => randomBytes(bytes).toString("base64");
const contents = `# Generated locally. Keep this file private and never commit it.
APP_PORT=3000
BROWSER_PUBLIC_PORT=8080
BROWSER_PUBLIC_BASE_URL=http://localhost:8080
POSTGRES_DB=canvas_grove
POSTGRES_ADMIN_USER=canvas_grove_admin
POSTGRES_ADMIN_PASSWORD=${hex()}
APP_DATABASE_USER=canvas_grove_app
APP_DATABASE_PASSWORD=${hex()}
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
HOSTED_BROWSER_PROVIDER=self-hosted
BROWSER_ORCHESTRATOR_SECRET=${hex()}
BROWSER_RELAY_CONTROL_SECRET=${hex()}
BROWSER_EGRESS_REGISTRATION_SECRET=${hex()}
BROWSER_IDLE_TTL_SECONDS=1800
BROWSER_STATE_KEK=${base64()}
BROWSER_STATE_KEK_ID=local-v1
`;
await writeFile(target, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
console.log("Created .env.docker with generated local secrets (values were not printed).");
console.log("Add your Clerk publishable and secret keys, then use the commands in SELF_HOSTING.md.");
