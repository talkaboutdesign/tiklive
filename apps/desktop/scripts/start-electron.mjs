// Starts Electron on apps/desktop. Clears ELECTRON_RUN_AS_NODE, which some hosts
// (including Electron-based terminals) set and which makes Electron run as plain Node.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const electron = createRequire(import.meta.url)("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ["."], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env,
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
