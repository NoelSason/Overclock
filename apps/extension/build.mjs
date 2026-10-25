// Builds the unpacked extension into dist/: bundles the side panel and the service worker with
// esbuild and copies the static files. Load dist/ at chrome://extensions (Developer mode).
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "public"), out, { recursive: true });
const common = { bundle: true, format: "esm", target: "chrome116", minify: true, sourcemap: false, legalComments: "none", logLevel: "warning" };
await build({ ...common, entryPoints: [join(root, "src/sidepanel.tsx")], outfile: join(out, "sidepanel.js"), jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
await build({ ...common, entryPoints: [join(root, "src/background.ts")], outfile: join(out, "background.js") });
console.log(`built ${out}`);
