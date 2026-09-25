/**
 * Build the dashboard bundle.
 *
 * The React source lives in `dashboard/`; the server (and both preview
 * servers) keep serving the plain static files in `web/`, so this script
 * compiles `dashboard/app.tsx` down to `web/app.js` + `web/app.css`.
 * Commit both outputs — a fresh checkout must run without a build step.
 *
 * Run: `bun run build` (after `bun run theme:build` when a theme changed)
 */
import {rm} from "node:fs/promises";

const outdir = new URL("../web/", import.meta.url).pathname;

// The bundle replaces both artefacts; clear stale hashed copies first.
await rm(new URL("../web/dist/", import.meta.url).pathname, {recursive: true, force: true});

const result = await Bun.build({
  entrypoints: ["dashboard/app.tsx"],
  outdir,
  target: "browser",
  minify: true,
  sourcemap: "none",
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  console.error("Dashboard bundle failed.");
  process.exit(1);
}

for (const output of result.outputs) {
  const size = (await output.arrayBuffer()).byteLength;
  console.log(`bundled ${output.path.replace(outdir, "web/")} (${size} bytes)`);
}

console.log(`OK: ${result.outputs.length} outputs written to web/`);
