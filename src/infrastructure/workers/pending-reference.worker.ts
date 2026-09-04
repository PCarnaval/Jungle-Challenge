import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ReprocessPendingReferences } from "../../application/use-cases/reprocess-pending-references/reprocess-pending-references.use-case";
import { workerEnabled, type AppConfig } from "../../config/app-config";
import { MetricsService } from "../observability/metrics.service";

/**
 * Sweeper agendado das transações PENDING_REFERENCE. Ticks não sobrepostos; um
 * sweep que falha é logado e retentado no próximo intervalo.
 */
@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private readonly reprocess: ReprocessPendingReferences,
    private readonly appConfig: AppConfig,
    private readonly intervalMs: number,
    private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!workerEnabled(this.appConfig.worker, "pending-reference")) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    this.logger.log(`started (interval ${this.intervalMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposto para testes / acionamento manual. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const summary = await this.reprocess.execute();
      this.metrics?.recordReferenceSweep(summary);
      if (summary.scanned > 0) {
        this.logger.log(`sweep ${JSON.stringify(summary)}`);
      }
    } catch (err) {
      this.logger.error(`sweep failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
