import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { PublishOutbox } from "../../../application/use-cases/publish-outbox/publish-outbox.use-case";
import { workerEnabled, type AppConfig } from "../../../config/app-config";
import { MetricsService } from "../../observability/metrics.service";

/**
 * Aciona o relay do outbox transacional num intervalo. Ticks não sobrepostos;
 * seguro de rodar com muitas réplicas (o use case reivindica as linhas com
 * `FOR UPDATE SKIP LOCKED`).
 */
@Injectable()
export class OutboxRelayWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private readonly relay: PublishOutbox,
    private readonly appConfig: AppConfig,
    private readonly intervalMs: number,
    private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!workerEnabled(this.appConfig.worker, "outbox")) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    this.logger.log(`started (interval ${this.intervalMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const summary = await this.relay.execute();
      this.metrics?.setOutbox(summary.pending, summary.oldestPendingAgeMs / 1000);
      this.metrics?.recordRetries("outbox", summary.retried);
      if (summary.claimed > 0) {
        this.logger.log(`relay ${JSON.stringify(summary)}`);
      }
    } catch (err) {
      this.logger.error(`relay failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
