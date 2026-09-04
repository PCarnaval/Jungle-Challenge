import { Global, Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";

import { APP_CONFIG } from "../../application/ports/tokens";
import type { AppConfig } from "../../config/app-config";
import { pinoConfig } from "./logging";
import { MetricsController } from "./metrics.controller";
import { MetricsService } from "./metrics.service";

/**
 * Logs estruturados (pino) + métricas Prometheus. Global, para que
 * `MetricsService` possa ser injetado pela factory de qualquer módulo.
 */
@Global()
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => pinoConfig(config),
    }),
  ],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService, LoggerModule],
})
export class ObservabilityModule {}
