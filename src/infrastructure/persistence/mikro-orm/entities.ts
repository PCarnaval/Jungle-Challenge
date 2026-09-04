import { Entity, Index, PrimaryKey, Property, Unique } from "@mikro-orm/core";

/**
 * Entidades de persistência. O schema é criado por migrations escritas à mão
 * (ver ./migrations) — estas classes só descrevem o formato que o EntityManager
 * hidrata. São intencionalmente anêmicas: sem comportamento, sem tipos de
 * domínio. Os agregados de domínio nunca importam nada deste arquivo.
 */

@Entity({ tableName: "wallet" })
@Unique({ name: "wallet_player_currency_uq", properties: ["playerId", "currency"] })
export class WalletEntity {
  @PrimaryKey({ type: "string", columnType: "uuid" })
  id!: string;

  @Property({ type: "string", columnType: "uuid", fieldName: "player_id" })
  playerId!: string;

  @Property({ type: "string", columnType: "varchar(3)" })
  currency!: string;

  @Property({ type: "string", columnType: "numeric(20,2)" })
  balance!: string;

  @Property({ type: "number" })
  version!: number;

  @Property({ type: "datetime", columnType: "timestamptz", fieldName: "created_at" })
  createdAt!: Date;

  @Property({ type: "datetime", columnType: "timestamptz", fieldName: "updated_at" })
  updatedAt!: Date;
}

@Entity({ tableName: "wager_transaction" })
@Index({ name: "wt_provider_reference_idx", properties: ["providerId", "referenceExternalTransactionId"] })
@Index({ name: "wt_wallet_idx", properties: ["walletId"] })
export class WagerTransactionEntity {
  @PrimaryKey({ type: "string", columnType: "uuid" })
  id!: string;

  @Property({ type: "string", fieldName: "provider_id" })
  providerId!: string;

  @Property({ type: "string", fieldName: "external_transaction_id" })
  externalTransactionId!: string;

  @Property({ type: "string", fieldName: "idempotency_key" })
  @Unique({ name: "wt_idempotency_key_uq" })
  idempotencyKey!: string;

  @Property({ type: "string", fieldName: "payload_hash" })
  payloadHash!: string;

  @Property({ type: "string", columnType: "uuid", fieldName: "wallet_id" })
  walletId!: string;

  @Property({ type: "string", columnType: "uuid", fieldName: "player_id" })
  playerId!: string;

  @Property({ type: "string", fieldName: "round_id", nullable: true })
  roundId!: string | null;

  @Property({ type: "string", fieldName: "game_id", nullable: true })
  gameId!: string | null;

  @Property({ type: "string" })
  kind!: string;

  @Property({ type: "string", columnType: "numeric(20,2)" })
  amount!: string;

  @Property({ type: "string", columnType: "varchar(3)" })
  currency!: string;

  @Property({ type: "string", fieldName: "reference_external_transaction_id", nullable: true })
  referenceExternalTransactionId!: string | null;

  @Property({ type: "string", columnType: "uuid", fieldName: "reference_transaction_id", nullable: true })
  referenceTransactionId!: string | null;

  @Property({ type: "string" })
  status!: string;

  @Property({ type: "string", fieldName: "failure_code", nullable: true })
  failureCode!: string | null;

  @Property({ type: "number", fieldName: "reference_attempts", default: 0 })
  referenceAttempts!: number;

  @Property({ type: "datetime", columnType: "timestamptz", fieldName: "next_attempt_at", nullable: true })
  nextAttemptAt!: Date | null;

  @Property({ type: "datetime", columnType: "timestamptz", fieldName: "pending_reference_since", nullable: true })
  pendingReferenceSince!: Date | null;

  @Property({ type: "string", columnType: "numeric(20,2)", fieldName: "observed_balance", nullable: true })
  observedBalance!: string | null;

  @Property({ type: "datetime", columnType: "timestamptz", fieldName: "created_at" })
  createdAt!: Date;

  @Property({ type: "datetime", columnType: "timestamptz", fieldName: "processed_at", nullable: true })
  processedAt!: Date | null;
}

@Entity({ tableName: "wallet_ledger_entry" })
@Unique({ name: "wle_wallet_transaction_uq", properties: ["walletId", "transactionId"] })
@Index({ name: "wle_wallet_pagination_idx", properties: ["walletId", "createdAt", "id"] })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: "string", columnType: "uuid" })
  id!: string;

  @Property({ type: "string", columnType: "uuid", fieldName: "wallet_id" })
  walletId!: string;

  @Property({ type: "string", columnType: "uuid", fieldName: "transaction_id" })
  transactionId!: string;

  @Property({ type: "string" })
  direction!: string;

  @Property({ type: "string", columnType: "numeric(20,2)" })
  amount!: string;

  @Property({ type: "string", columnType: "varchar(3)" })
  currency!: string;

  @Property({ type: "string", columnType: "numeric(20,2)", fieldName: "balance_before" })
  balanceBefore!: string;

  @Property({ type: "string", columnType: "numeric(20,2)", fieldName: "balance_after" })
  balanceAfter!: string;

  @Property({ type: "datetime", columnType: "timestamptz", fieldName: "created_at" })
  createdAt!: Date;
}

@Entity({ tableName: "inbox_message" })
export class InboxMessageEntity {
  @PrimaryKey({ type: "string", fieldName: "consumer_name" })
  consumerName!: string;

  @PrimaryKey({ type: "string", fieldName: "message_id" })
  messageId!: string;

  @Property({ type: "string", fieldName: "payload_hash" })
  payloadHash!: string;

  @Property({ type: "datetime", columnType: "timestamptz", fieldName: "received_at" })
  receivedAt!: Date;

  @Property({ type: "datetime", columnType: "timestamptz", fieldName: "processed_at", nullable: true })
  processedAt!: Date | null;
}

@Entity({ tableName: "outbox_message" })
@Index({ name: "outbox_due_idx", properties: ["occurredAt"] })
export class OutboxMessageEntity {
  @PrimaryKey({ type: "string", columnType: "uuid" })
  id!: string;

  @Property({ type: "string", fieldName: "aggregate_id" })
  aggregateId!: string;

  @Property({ type: "string", fieldName: "event_type" })
  eventType!: string;

  @Property({ type: "json", columnType: "jsonb" })
  payload!: Record<string, unknown>;

  @Property({ type: "datetime", columnType: "timestamptz", fieldName: "occurred_at" })
  occurredAt!: Date;

  @Property({ type: "number", default: 0 })
  attempts!: number;

  @Property({ type: "datetime", columnType: "timestamptz", fieldName: "next_attempt_at", nullable: true })
  nextAttemptAt!: Date | null;

  @Property({ type: "datetime", columnType: "timestamptz", fieldName: "published_at", nullable: true })
  publishedAt!: Date | null;

  @Property({ type: "datetime", columnType: "timestamptz", fieldName: "created_at" })
  createdAt!: Date;
}

export const ALL_ENTITIES = [
  WalletEntity,
  WagerTransactionEntity,
  WalletLedgerEntryEntity,
  InboxMessageEntity,
  OutboxMessageEntity,
] as const;
