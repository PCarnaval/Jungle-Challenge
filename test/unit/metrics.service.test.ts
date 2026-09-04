import { describe, expect, it } from "bun:test";
import { MetricsService } from "../../src/infrastructure/observability/metrics.service";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction";

describe("MetricsService", () => {
  it("renders Prometheus text with the wager_ metrics and default metrics", async () => {
    const metrics = new MetricsService();
    metrics.recordTransaction({
      kind: "BET",
      status: WagerTransactionStatus.Processed,
      source: "http",
      durationSeconds: 0.012,
      idempotentReplay: false,
    });
    metrics.recordTransaction({
      kind: "BET",
      status: WagerTransactionStatus.Processed,
      source: "sqs",
      durationSeconds: 0.02,
      idempotentReplay: true,
    });
    metrics.recordDuplicate("inbox");
    metrics.recordRetries("outbox", 3);
    metrics.recordDlq("permanent");
    metrics.recordLockConflict();
    metrics.setOutbox(5, 2.5);
    metrics.recordReconciliationMismatch();
    metrics.recordLockWait(0.003);
    metrics.recordOutboxPublish("WalletBalanceChanged", 0.041);

    const text = await metrics.render();

    expect(text).toContain('wager_transactions_total{kind="BET",status="PROCESSED",source="http"} 1');
    expect(text).toContain("wager_idempotent_replays_total{source=\"sqs\"} 1");
    expect(text).toContain('wager_duplicates_detected_total{type="inbox"} 1');
    expect(text).toContain('wager_retries_total{component="outbox"} 3');
    expect(text).toContain('wager_dlq_messages_total{reason="permanent"} 1');
    expect(text).toContain("wager_lock_conflicts_total 1");
    expect(text).toContain("wager_outbox_pending 5");
    expect(text).toContain("wager_outbox_lag_seconds 2.5");
    expect(text).toContain("wager_reconciliation_mismatches_total 1");
    expect(text).toContain("wager_processing_duration_seconds_bucket");
    expect(text).toContain("wager_wallet_lock_wait_seconds_bucket");
    expect(text).toContain("wager_wallet_lock_wait_seconds_sum 0.003");
    expect(text).toContain(
      'wager_outbox_publish_duration_seconds_bucket{le="0.05",eventType="WalletBalanceChanged"} 1',
    );
    // métricas padrão do processo, com namespace
    expect(text).toContain("wager_process_cpu_seconds_total");
  });

  it("keeps separate registries per instance (no double-registration crash)", () => {
    expect(() => {
      new MetricsService();
      new MetricsService();
    }).not.toThrow();
  });
});
