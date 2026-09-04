import { Injectable } from "@nestjs/common";
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

import type { WagerTransactionStatus } from "../../domain/wagering/wager-transaction";

export type MetricSource = "http" | "sqs" | "worker";
export type RetryComponent = "consumer" | "outbox" | "pending_reference";
export type DuplicateType = "idempotency" | "inbox";
export type DlqReason = "parse_error" | "permanent";
export type AuthFailureReason =
  | "missing_headers"
  | "unknown_provider"
  | "bad_signature"
  | "stale_timestamp"
  | "provider_mismatch"
  | "malformed";

/**
 * Métricas Prometheus (README item 12). Um `Registry` privado por instância,
 * para que várias instâncias da app no mesmo processo de teste não colidam em
 * `collectDefaultMetrics`.
 */
@Injectable()
export class MetricsService {
  private readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wager_transactions_total",
    help: "Wager transactions by kind and final status",
    labelNames: ["kind", "status", "source"] as const,
    registers: [this.registry],
  });

  private readonly idempotentReplays = new Counter({
    name: "wager_idempotent_replays_total",
    help: "Requests answered from a stored outcome",
    labelNames: ["source"] as const,
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: "wager_duplicates_detected_total",
    help: "Duplicate detections by mechanism",
    labelNames: ["type"] as const,
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: "wager_retries_total",
    help: "Retries scheduled by component",
    labelNames: ["component"] as const,
    registers: [this.registry],
  });

  private readonly dlqMessages = new Counter({
    name: "wager_dlq_messages_total",
    help: "Messages routed to the DLQ",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: "wager_lock_conflicts_total",
    help: "Deadlocks / lost-update conflicts normalized to transient failures",
    registers: [this.registry],
  });

  private readonly walletLockWait = new Histogram({
    name: "wager_wallet_lock_wait_seconds",
    help: "Time spent waiting to acquire the SELECT ... FOR UPDATE lock on a wallet row",
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
    registers: [this.registry],
  });

  private readonly outboxPublishDuration = new Histogram({
    name: "wager_outbox_publish_duration_seconds",
    help: "Latency of a single publish call to the broker, per event type",
    labelNames: ["eventType"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  private readonly outboxPending = new Gauge({
    name: "wager_outbox_pending",
    help: "Unpublished outbox rows",
    registers: [this.registry],
  });

  private readonly outboxLag = new Gauge({
    name: "wager_outbox_lag_seconds",
    help: "Age of the oldest unpublished outbox row",
    registers: [this.registry],
  });

  private readonly processingDuration = new Histogram({
    name: "wager_processing_duration_seconds",
    help: "ProcessWagerTransaction latency",
    labelNames: ["kind", "outcome"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  private readonly reconciliationMismatches = new Counter({
    name: "wager_reconciliation_mismatches_total",
    help: "Reconciliations where stored balance != ledger sum",
    registers: [this.registry],
  });

  private readonly authFailures = new Counter({
    name: "wager_auth_failures_total",
    help: "Rejected requests by HMAC auth reason",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: "wager_" });
  }

  recordTransaction(params: {
    kind: string;
    status: WagerTransactionStatus | string;
    source: MetricSource;
    durationSeconds: number;
    idempotentReplay: boolean;
  }): void {
    this.transactions.inc({ kind: params.kind, status: params.status, source: params.source });
    this.processingDuration.observe(
      { kind: params.kind, outcome: params.idempotentReplay ? "replay" : params.status },
      params.durationSeconds,
    );
    if (params.idempotentReplay) {
      this.idempotentReplays.inc({ source: params.source });
    }
  }

  recordDuplicate(type: DuplicateType): void {
    this.duplicates.inc({ type });
  }

  recordRetries(component: RetryComponent, count: number): void {
    if (count > 0) this.retries.inc({ component }, count);
  }

  recordReferenceSweep(summary: { processed: number; rejected: number; retried: number }): void {
    if (summary.processed > 0) {
      this.transactions.inc(
        { kind: "REVERSAL", status: "PROCESSED", source: "worker" },
        summary.processed,
      );
    }
    if (summary.rejected > 0) {
      this.transactions.inc(
        { kind: "REVERSAL", status: "REJECTED", source: "worker" },
        summary.rejected,
      );
    }
    this.recordRetries("pending_reference", summary.retried);
  }

  recordDlq(reason: DlqReason): void {
    this.dlqMessages.inc({ reason });
  }

  recordLockConflict(): void {
    this.lockConflicts.inc();
  }

  recordLockWait(seconds: number): void {
    this.walletLockWait.observe(seconds);
  }

  recordOutboxPublish(eventType: string, seconds: number): void {
    this.outboxPublishDuration.observe({ eventType }, seconds);
  }

  setOutbox(pending: number, lagSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxLag.set(lagSeconds);
  }

  recordReconciliationMismatch(): void {
    this.reconciliationMismatches.inc();
  }

  recordAuthFailure(reason: AuthFailureReason): void {
    this.authFailures.inc({ reason });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
