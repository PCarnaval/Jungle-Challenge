import {
  type IntegrationEvent,
  type IntegrationEventEnvelope,
} from "./integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: IntegrationEventEnvelope<unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/** Teto do backoff, para que `nextAttemptAt` nunca vá para um futuro absurdo. */
const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1h
const DEFAULT_BASE_BACKOFF_MS = 500;

/**
 * Um evento de integração pendente, escrito na mesma transação SQL da mudança de
 * estado que ele descreve. Um worker de relay o publica no broker e chama
 * `markPublished`; falhas chamam `scheduleRetry`.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<IntegrationEventEnvelope<unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** O id da linha do outbox reusa o id do evento, tornando `enqueue` naturalmente idempotente. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage(
      envelope.eventId,
      envelope.aggregateId,
      envelope.eventType,
      envelope,
      event.occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    this._publishedAt ??= at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa `attempts` e calcula o próximo `nextAttemptAt` (backoff exponencial). */
  scheduleRetry(now: Date, baseBackoffMs: number = DEFAULT_BASE_BACKOFF_MS): void {
    this._attempts += 1;
    const delay = Math.min(baseBackoffMs * 2 ** (this._attempts - 1), MAX_BACKOFF_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }

  toState(): OutboxMessageState {
    return {
      id: this.id,
      aggregateId: this.aggregateId,
      eventType: this.eventType,
      payload: this.payload,
      occurredAt: this.occurredAt,
      attempts: this._attempts,
      nextAttemptAt: this._nextAttemptAt,
      publishedAt: this._publishedAt,
    };
  }
}
