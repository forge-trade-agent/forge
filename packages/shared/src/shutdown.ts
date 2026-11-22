import type { Logger } from "pino";

type Closer = { name: string; close: () => Promise<unknown> | unknown };

/**
 * Graceful shutdown: on SIGINT/SIGTERM, run closers in reverse registration order,
 * each with a timeout, then exit. A second signal forces exit.
 */
export function installShutdown(log: Logger, timeoutMs = 10_000) {
  const closers: Closer[] = [];
  let shuttingDown = false;

  const run = async (signal: string) => {
    if (shuttingDown) {
      log.warn({ signal }, "second signal, forcing exit");
      process.exit(1);
    }
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    for (const c of [...closers].reverse()) {
      try {
        await Promise.race([
          Promise.resolve(c.close()),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
        ]);
        log.info({ closer: c.name }, "closed");
      } catch (err) {
        log.error({ closer: c.name, err }, "close failed");
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void run("SIGINT"));
  process.on("SIGTERM", () => void run("SIGTERM"));

  return {
    register(name: string, close: Closer["close"]) {
      closers.push({ name, close });
    },
    get isShuttingDown() {
      return shuttingDown;
    },
  };
}
