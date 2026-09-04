import { Module } from "@nestjs/common";

import { ApplicationModule } from "../../application/application.module";
import { APP_CONFIG } from "../../application/ports/tokens";
import { ReprocessPendingReferences } from "../../application/use-cases/reprocess-pending-references/reprocess-pending-references.use-case";
import type { AppConfig } from "../../config/app-config";
import { MetricsService } from "../observability/metrics.service";
import { PendingReferenceWorker } from "./pending-reference.worker";

/**
 * O sweeper agendado de PENDING_REFERENCE. Ele se auto-habilita por `WORKER`
 * (`pending-reference` | `all`) dentro de `onModuleInit`.
 */
@Module({
  imports: [ApplicationModule],
  providers: [
    {
      provide: PendingReferenceWorker,
      useFactory: (
        reprocess: ReprocessPendingReferences,
        config: AppConfig,
        metrics: MetricsService,
      ) =>
        new PendingReferenceWorker(
          reprocess,
          config,
          Number(process.env.PENDING_REFERENCE_POLL_INTERVAL_MS ?? 5000),
          metrics,
        ),
      inject: [ReprocessPendingReferences, APP_CONFIG, MetricsService],
    },
  ],
  exports: [PendingReferenceWorker],
})
export class WorkersModule {}
