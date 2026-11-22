import { pino, type Logger } from "pino";

/** Structured JSON logger. Secrets and capability material are redacted by path. */
export function createLogger(service: string, level: string = "info"): Logger {
  return pino({
    name: service,
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.privateKey",
        "*.RELAYER_PRIVATE_KEY",
        "*.token",
        "*.ciphertext",
        "*.destination",
      ],
      censor: "[redacted]",
    },
  });
}

export type { Logger };
