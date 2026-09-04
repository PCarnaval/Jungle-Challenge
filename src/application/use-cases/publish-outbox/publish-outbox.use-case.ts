import type { Clock, MessagePublisher } from "../../ports/system.ports";
import type { UnitOfWork } from "../../ports/unit-of-work.port";

export interface OutboxRelayConfig {
  batchSize: number;
  baseBackoffMs: number;
}

export interface OutboxRelaySummary {
  claimed: number;
  published: number;
  retried: number;
  /** Linhas não publicadas que restaram depois deste ciclo. */
  pending: number;
  /** Idade da linha não publicada mais antiga depois deste ciclo, em ms (0 se não houver). */
  oldestPendingAgeMs: number;
}

/**
 * Relay do outbox transacional (README item 11). Um `execute()` reivindica um
 * batch de linhas vencidas com `FOR UPDATE SKIP LOCKED`, publica cada uma no
 * broker e a marca como publicada (ou agenda um retry) — tudo dentro de UMA
 * transação, então as linhas ficam travadas até serem publicadas e relays
 * concorrentes nunca as tocam.
 *
 * Uma publicação duplicada é segura: todo consumidor é idempotente (inbox +
 * chave de idempotência de negócio), e a fila de eventos é FIFO com
 * `MessageDeduplicationId = eventId`.
 */
export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: MessagePublisher,
    private readonly clock: Clock,
    private readonly config: OutboxRelayConfig,
  ) {}

  async execute(): Promise<OutboxRelaySummary> {
    const now = this.clock.now();

    return this.uow.run({ name: "outbox:relay" }, async (repos): Promise<OutboxRelaySummary> => {
      const due = await repos.outbox.claimDue(this.config.batchSize, now);
      let published = 0;
      let retried = 0;

      for (const message of due) {
        try {
          await this.publisher.publish(message.payload);
          message.markPublished(now);
          published += 1;
        } catch {
          message.scheduleRetry(now, this.config.baseBackoffMs);
          retried += 1;
        }
        await repos.outbox.save(message);
      }

      const pending = await repos.outbox.countPending();
      const oldestPendingAgeMs = await repos.outbox.oldestPendingAgeMs(now);
      return { claimed: due.length, published, retried, pending, oldestPendingAgeMs };
    });
  }
}
