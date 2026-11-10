const path = require("node:path");
const fs = require("node:fs");
const projectRoot = path.resolve(__dirname, "..");
const standaloneRoot = path.join(projectRoot, ".next", "standalone");

fs.mkdirSync(path.join(standaloneRoot, ".next"), { recursive: true });
fs.cpSync(path.join(projectRoot, ".next", "static"), path.join(standaloneRoot, ".next", "static"), { recursive: true, force: true });
if (fs.existsSync(path.join(projectRoot, "public"))) fs.cpSync(path.join(projectRoot, "public"), path.join(standaloneRoot, "public"), { recursive: true, force: true });

require("@next/env").loadEnvConfig(projectRoot);
process.env.PORT = "3101";
process.env.HOSTNAME = "127.0.0.1";
process.env.UI_FORWARD_PREVIEW = "1";
require(path.join(standaloneRoot, "server.js"));
