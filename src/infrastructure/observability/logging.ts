import { randomUUID } from "node:crypto";
import { stdTimeFunctions } from "pino";
import type { Params } from "nestjs-pino";
import type { AppConfig } from "../../config/app-config";

const QUIET_PATHS = new Set(["/health/live", "/health/ready", "/metrics"]);

/**
 * Config do pino para o `nestjs-pino`. Só JSON, timestamps ISO, um
 * `correlationId` em toda linha com escopo de requisição (do header
 * `x-correlation-id` ou gerado e devolvido), e redação agressiva para que
 * nenhum valor de dinheiro / payload / header de auth chegue aos logs
 * (README item 12).
 */
export function pinoConfig(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.logLevel,
      messageKey: "message",
      timestamp: stdTimeFunctions.isoTime,
      genReqId: (req, res) => {
        const header = req.headers["x-correlation-id"];
        const id = (Array.isArray(header) ? header[0] : header) || randomUUID();
        res.setHeader("x-correlation-id", id);
        return id;
      },
      customProps: (req) => ({ correlationId: (req as { id?: string }).id }),
      autoLogging: {
        ignore: (req) => QUIET_PATHS.has((req.url ?? "").split("?")[0] ?? ""),
      },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'req.headers["x-signature"]',
          "req.body",
          "res.body",
          "*.money",
          "*.amount",
          "*.balance",
          "*.initialBalance",
          "*.payload",
          "*.data",
        ],
        remove: true,
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    },
  };
}
