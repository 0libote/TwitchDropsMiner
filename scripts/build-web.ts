/**
 * Verify the dashboard bundles cleanly with Bun's bundler.
 *
 * This is a verification/build step only: production still serves `web/`
 * directly via `webui.py` (`add_static("/assets", WEB_ROOT)`). The output in
 * `web/dist/` is gitignored and exists to catch syntax errors, measure
 * minified sizes, and unblock a future switch to serving hashed bundles.
 *
 * Run: `bun run build`
 */
import { mkdir } from "node:fs/promises";

const outdir = new URL("../web/dist/", import.meta.url).pathname;

await mkdir(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: ["web/app.js", "web/theme.js", "web/app.css"],
  outdir,
  minify: true,
  sourcemap: "external",
  target: "browser",
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
  console.log(`bundled ${output.path.replace(outdir, "web/dist/")} (${size} bytes)`);
}

console.log(`OK: ${result.outputs.length} bundle outputs in web/dist/ (gitignored)`);
