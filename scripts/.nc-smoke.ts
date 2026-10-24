import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setupEnv, exportFixture } from "../tests/network-capability/fixtures";
const env = await setupEnv();
try {
  writeFileSync("/private/tmp/claude-501/-Users-noelsason-Library-Application-Support-Claude-scratch-workspaces-af6e6f19-5099-4eb5-88d1-a7874b5a4618-6707dd27-7f3b-4845-9e34-8567dbab47b8-scratch-2026-10-24-b8bf8c/93d09b96-f560-4381-aaed-a8f59de34273/scratchpad/cap.json", JSON.stringify(exportFixture(env).capability));
  const out = execFileSync("npx", ["tsx", "services/network/validation-worker/src/main.ts", "--file", "/private/tmp/claude-501/-Users-noelsason-Library-Application-Support-Claude-scratch-workspaces-af6e6f19-5099-4eb5-88d1-a7874b5a4618-6707dd27-7f3b-4845-9e34-8567dbab47b8-scratch-2026-10-24-b8bf8c/93d09b96-f560-4381-aaed-a8f59de34273/scratchpad/cap.json", "--arena", env.arena.adminOrigin], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
  const j = JSON.parse(out);
  console.log("exit 0", j.result.outcome, j.result.category, j.ms + "ms", "digest", j.result.evidenceDigest.slice(0, 12));
} catch (e) { console.log("FAILED", (e as { stdout?: string; stderr?: string }).stdout?.slice(0, 800), (e as { stderr?: string }).stderr?.slice(-800)); }
finally { await env.close(); }
