import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger as PinoLogger } from "nestjs-pino";

import { AppModule } from "./app.module";
import { APP_CONFIG } from "./application/ports/tokens";
import type { AppConfig } from "./config/app-config";
import { DomainExceptionFilter } from "./infrastructure/http/filters/domain-exception.filter";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(PinoLogger)); // roteia todos os logs do Nest pelo pino (JSON)
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableShutdownHooks();

  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.httpPort, "0.0.0.0");

  app
    .get(PinoLogger)
    .log(
      `HTTP API listening on :${config.httpPort} (worker=${config.worker}, env=${config.nodeEnv})`,
    );
}

void bootstrap();
