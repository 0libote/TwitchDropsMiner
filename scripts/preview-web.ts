/**
 * Bun-native read-only dashboard preview.
 *
 * Mirrors `scripts/preview_web.py` (which remains the CI-canonical preview)
 * using `Bun.serve()` + `Bun.file()` instead of `http.server`. Loopback-only,
 * no Twitch connection, fictional fixtures only. Writes are rejected with 409
 * so browser suites can verify read-only behavior.
 *
 * Run:
 *   bun run preview            # :8095, same default as preview_web.py
 *   bun scripts/preview-web.ts --port 8095
 *
 * Then: `bun run test:browser` in another terminal.
 */
const REPO = (import.meta.dir ?? process.cwd()).replace(/\/scripts$/, "");

function rootFile(...parts: string[]): string {
  // import.meta.dir is `.../scripts`; fixtures live in `tests/fixtures`, UI in `web/`.
  return [REPO, ...parts].join("/").replace(/\/+/g, "/");
}

function parsePort(): number {
  const flag = process.argv.findIndex((a) => a === "--port" || a === "-p");
  const raw =
    (flag >= 0 ? process.argv[flag + 1] : undefined) ??
    process.env.TDM_PREVIEW_PORT ??
    "8095";
  const port = Number.parseInt(String(raw), 10);
  return Number.isFinite(port) && port > 0 && port < 65536 ? port : 8095;
}

const PORT = parsePort();

const SPA_ROUTES = new Set(["/", "/campaigns", "/mining", "/settings", "/diagnostics", "/history"]);
const ASSETS: Record<string, string> = {
  "/assets/app.js": "text/javascript; charset=utf-8",
  "/assets/theme.js": "text/javascript; charset=utf-8",
  "/assets/app.css": "text/css; charset=utf-8",
};

async function historyPayload(url: URL): Promise<Response> {
  const file = Bun.file(rootFile("tests", "fixtures", "history.json"));
  const payload = (await file.json()) as {
    items: Array<{
      gameId?: string | null;
      name?: string;
      gameName?: string;
      campaignName?: string;
    }>;
  };
  const game = url.searchParams.get("game") ?? "";
  const search = (url.searchParams.get("q") ?? "").toLowerCase();
  const rawOffset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;
  const items = (payload.items ?? []).filter((row) => {
    const gameOk = !game || (row.gameId || "unknown") === game;
    const haystack = `${row.name ?? ""} ${row.gameName ?? ""} ${row.campaignName ?? ""}`.toLowerCase();
    return gameOk && haystack.includes(search);
  });
  return Response.json(
    { ...payload, items: items.slice(offset, offset + 50), total: items.length, offset, limit: 50 },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function eventsStream(): Response {
  let timer: Timer | undefined;
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const state = await Bun.file(rootFile("tests", "fixtures", "web_state.json")).text();
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(JSON.parse(state))}\n\n`));
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: preview keepalive\n\n`));
        } catch {
          // Client went away; cleanup happens in cancel().
        }
      }, 15_000);
    },
    cancel() {
      if (timer !== undefined) clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  development: process.env.NODE_ENV !== "production",
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("This is a read-only preview. Run the miner to use this action.", {
        status: 409,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (path === "/api/csrf") {
      // Fixed placeholder for a loopback-only, read-only preview server;
      // this is not a credential.
      return Response.json({ token: "read-only-preview" });
    }
    if (path === "/api/history") return historyPayload(url);
    if (path === "/api/events") return eventsStream();

    if (path in ASSETS) {
      const fileName = path.split("/").at(-1) ?? "";
      const file = Bun.file(rootFile("web", fileName));
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return new Response(file, {
        headers: {
          "Content-Type": ASSETS[path]!,
          "Cache-Control": "no-store",
        },
      });
    }

    if (SPA_ROUTES.has(path) || path.startsWith("/campaigns/")) {
      const file = Bun.file(rootFile("web", "index.html"));
      return new Response(file, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Read-only dashboard preview (Bun): http://127.0.0.1:${server.port}/`);
console.log(`Fixtures: tests/fixtures/web_state.json + history.json (fictional, no live miner)`);
