/**
 * Port of `main.py`: CLI, signal handling and the run-until-closed lifecycle
 * for the Bun dashboard + engine. Docker holds the data-directory lock.
 *
 * Flags mirror the Python CLI (`--host/--port/--no-browser/--log/-v`,
 * plus hidden `--dump/--debug-ws/--debug-gql`). `--tray` is gone with the
 * desktop builds. `TDM_*` environment variables behave identically.
 */

import { AsyncEvent } from "./async.ts";
import { Twitch } from "./engine.ts";
import { CaptchaRequired, ExitRequest, LoginException } from "./errors.ts";
import { DashboardServer } from "./server.ts";
import { Settings } from "./settings.ts";
import { CLIENT_TYPES } from "./twitchProtocol.ts";
import { FORK_VERSION, UPSTREAM_VERSION } from "./version.ts";

interface Cli {
  verbose: number;
  debugWs: boolean;
  debugGql: boolean;
  log: boolean;
  dump: boolean;
  host: string;
  port: number;
  noBrowser: boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    verbose: 0,
    debugWs: false,
    debugGql: false,
    log: ["1", "true", "yes"].includes((process.env["TDM_LOG"] ?? "").toLowerCase()),
    dump: false,
    host: process.env["TDM_HOST"] ?? "127.0.0.1",
    port: Number(process.env["TDM_PORT"] ?? "8080"),
    noBrowser: ["1", "true", "yes"].includes((process.env["TDM_NO_BROWSER"] ?? "").toLowerCase()),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (/^-v+$/.test(arg)) cli.verbose += arg.length - 1;
    else if (arg === "--log") cli.log = true;
    else if (arg === "--dump") cli.dump = true;
    else if (arg === "--no-browser") cli.noBrowser = true;
    else if (arg === "--debug-ws") cli.debugWs = true;
    else if (arg === "--debug-gql") cli.debugGql = true;
    else if (arg === "--host") cli.host = argv[++i] ?? cli.host;
    else if (arg.startsWith("--host=")) cli.host = arg.slice("--host=".length);
    else if (arg === "--port") cli.port = Number(argv[++i] ?? cli.port);
    else if (arg.startsWith("--port=")) cli.port = Number(arg.slice("--port=".length));
    else if (arg === "--version") {
      console.log(`Twitch Drops Miner Next ${FORK_VERSION} (upstream engine ${UPSTREAM_VERSION})`);
      process.exit(0);
    } else if (arg === "-h" || arg === "--help") {
      console.log("Mine timed Twitch drops from a local or hosted dashboard.\n\nOptions:\n  --host ADDRESS  Dashboard bind address (default: 127.0.0.1)\n  --port PORT     Dashboard port (default: 8080)\n  --no-browser    Do not launch a browser automatically\n  --log           Write log.txt in the data directory\n  -v              Increase verbosity (repeatable)");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return cli;
}

function openDashboard(url: string): void {
  try {
    const command =
      process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
    const proc = Bun.spawn(command, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    proc.unref();
  } catch {
    // Best effort only.
  }
}

async function main(): Promise<number> {
  const cli = parseArgs(process.argv.slice(2));
  try {
    process.umask?.(0o077);
  } catch {
    // Non-POSIX platforms.
  }
  const dataDir = process.env["TDM_DATA_DIR"] ?? process.cwd();
  const settings = new Settings(`${dataDir}/settings.json`, {
    log: cli.log,
    dump: cli.dump,
    debug_ws: cli.debugWs,
    debug_gql: cli.debugGql,
    logging_level: cli.verbose,
  });
  const closeEvent = new AsyncEvent();
  const server = new DashboardServer({
    dataDir,
    settings,
    host: cli.host,
    port: cli.port,
    openBrowser: !cli.noBrowser,
    closeEvent,
  });
  const engine = new Twitch({ dataDir, settings, gui: server, closeEvent, clientType: CLIENT_TYPES.SMARTBOX });
  server.attachEngine(engine);
  const onSignal = (): void => server.close();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let exitStatus = 0;
  const runMiner = engine.run();
  if (!cli.noBrowser) {
    // Mirror main.py: the browser opens once the server is up.
    const opened = { current: false };
    const check = setInterval(() => {
      if (opened.current) {
        clearInterval(check);
        return;
      }
      fetch(server.dashboardUrl.replace("0.0.0.0", "127.0.0.1"))
        .then(() => {
          opened.current = true;
          clearInterval(check);
          openDashboard(server.dashboardUrl);
        })
        .catch(() => {});
    }, 500);
    void runMiner.finally(() => clearInterval(check));
  }
  try {
    await Promise.race([
      runMiner.then(() => "miner" as const),
      server.waitUntilClosed().then(() => {
        engine.close();
        return "closed" as const;
      }),
    ]);
  } catch (error) {
    exitStatus = 1;
    if (!(error instanceof ExitRequest)) {
      server.notifier.set_activity("error");
      server.status.update("Miner needs attention; check Activity or container logs");
    }
    if (error instanceof CaptchaRequired) {
      server.preventClose();
      console.error(translateCaptcha());
      engine.print(translateCaptcha());
      await server.waitUntilClosed();
    } else if (error instanceof LoginException) {
      server.preventClose();
      console.error(`Login failed: ${error.message}`);
      engine.print(`Login failed: ${error.message}`);
      await server.waitUntilClosed();
    } else if (!(error instanceof ExitRequest)) {
      const details = error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error(`Fatal error encountered:\n${details}`);
      engine.print(`Fatal error encountered:\n${details}`);
      server.preventClose();
      await server.waitUntilClosed();
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    engine.print("Exiting");
    await engine.shutdown().catch(() => {});
  }
  engine.save(true);
  server.stop();
  return exitStatus;
}

function translateCaptcha(): string {
  return "Your login attempt was denied by CAPTCHA.\nPlease try again in 12+ hours.";
}

const status = await main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  return 1;
});
process.exit(status);
