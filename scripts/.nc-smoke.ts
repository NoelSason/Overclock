import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setupEnv, exportFixture } from "../tests/network-capability/fixtures";
const env = await setupEnv();
try {
  writeFileSync("/private/tmp/claude-501/-Users-noelsason-Library-Application-Support-Claude-scratch-workspaces-af6e6f19-5099-4eb5-88d1-a7874b5a4618-6707dd27-7f3b-4845-9e34-8567dbab47b8-scratch-2026-10-24-b8bf8c/93d09b96-f560-4381-aaed-a8f59de34273/scratchpad/cap.json", JSON.stringify(exportFixture(env).capability));
  const r = spawnSync("npx", ["tsx", "services/network/validation-worker/src/main.ts", "--file", "/private/tmp/claude-501/-Users-noelsason-Library-Application-Support-Claude-scratch-workspaces-af6e6f19-5099-4eb5-88d1-a7874b5a4618-6707dd27-7f3b-4845-9e34-8567dbab47b8-scratch-2026-10-24-b8bf8c/93d09b96-f560-4381-aaed-a8f59de34273/scratchpad/cap.json", "--arena", env.arena.adminOrigin], { encoding: "utf8", timeout: 120000 });
  console.log("status", r.status, "signal", r.signal, "error", r.error?.message);
  console.log("STDOUT", r.stdout.slice(0, 1500));
  console.log("STDERR", r.stderr.split("\n").filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).join("\n").slice(-1500));
} finally { await env.close(); }
