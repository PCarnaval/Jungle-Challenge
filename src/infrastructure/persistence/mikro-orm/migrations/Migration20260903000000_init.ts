import { Migration } from "@mikro-orm/migrations";

/**
 * Schema inicial. Escrito à mão para que toda garantia de unicidade /
 * imutabilidade / não-negatividade (README item 5.9) viva no banco, não só no
 * código de aplicação.
 */
export class Migration20260903000000_init extends Migration {
  override async up(): Promise<void> {
    // ---- wallet ---------------------------------------------------------------
    this.addSql(`
      create table "wallet" (
        "id" uuid not null,
        "player_id" uuid not null,
        "currency" varchar(3) not null,
        "balance" numeric(20,2) not null default 0,
        "version" int not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "wallet_pkey" primary key ("id"),
        constraint "wallet_balance_non_negative" check ("balance" >= 0),
        constraint "wallet_version_positive" check ("version" >= 1),
        constraint "wallet_currency_len" check (char_length("currency") = 3)
      );
    `);
    this.addSql(
      `create unique index "wallet_player_currency_uq" on "wallet" ("player_id", "currency");`,
    );

    // ---- wager_transaction --------------------------------------------------
    this.addSql(`
      create table "wager_transaction" (
        "id" uuid not null,
        "provider_id" text not null,
        "external_transaction_id" text not null,
        "idempotency_key" text not null,
        "payload_hash" text not null,
        "wallet_id" uuid not null,
        "player_id" uuid not null,
        "round_id" text null,
        "game_id" text null,
        "kind" text not null,
        "amount" numeric(20,2) not null,
        "currency" varchar(3) not null,
        "reference_external_transaction_id" text null,
        "reference_transaction_id" uuid null,
        "status" text not null,
        "failure_code" text null,
        "reference_attempts" int not null default 0,
        "next_attempt_at" timestamptz null,
        "pending_reference_since" timestamptz null,
        "observed_balance" numeric(20,2) null,
        "created_at" timestamptz not null default now(),
        "processed_at" timestamptz null,
        constraint "wager_transaction_pkey" primary key ("id"),
        constraint "wt_kind_chk" check ("kind" in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint "wt_status_chk" check ("status" in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint "wt_amount_positive" check ("amount" > 0),
        constraint "wt_currency_len" check (char_length("currency") = 3),
        constraint "wt_reference_required"
          check ("kind" not in ('REFUND','ROLLBACK') or "reference_external_transaction_id" is not null),
        constraint "wt_context_required"
          check ("kind" = 'OPENING' or ("round_id" is not null and "game_id" is not null)),
        constraint "wt_processed_at_consistency"
          check (("status" = 'PROCESSED') = ("processed_at" is not null)),
        constraint "wt_failure_code_consistency"
          check ("status" in ('REJECTED','FAILED') or "failure_code" is null),
        constraint "wt_reference_attempts_non_negative" check ("reference_attempts" >= 0),
        constraint "wt_observed_balance_non_negative"
          check ("observed_balance" is null or "observed_balance" >= 0),
        constraint "wt_wallet_fk" foreign key ("wallet_id") references "wallet" ("id"),
        constraint "wt_reference_fk" foreign key ("reference_transaction_id") references "wager_transaction" ("id")
      );
    `);
    this.addSql(
      `create unique index "wt_idempotency_key_uq" on "wager_transaction" ("idempotency_key");`,
    );
    this.addSql(
      `create unique index "wt_provider_external_uq" on "wager_transaction" ("provider_id", "external_transaction_id");`,
    );
    this.addSql(
      `create index "wt_provider_reference_idx" on "wager_transaction" ("provider_id", "reference_external_transaction_id");`,
    );
    this.addSql(`create index "wt_wallet_idx" on "wager_transaction" ("wallet_id");`);
    this.addSql(
      `create index "wt_due_pending_reference_idx" on "wager_transaction" ("next_attempt_at") where "status" = 'PENDING_REFERENCE';`,
    );
    // Regra 4 do item 7: uma referência é revertida no máximo uma vez por tipo
    // de operação. Falhas terminais (REJECTED/FAILED) ficam de fora, para que
    // uma tentativa rejeitada não bloqueie uma válida posterior.
    this.addSql(`
      create unique index "wt_one_active_reversal_per_kind"
        on "wager_transaction" ("reference_transaction_id", "kind")
        where "kind" in ('REFUND','ROLLBACK')
          and "status" in ('PENDING','PENDING_REFERENCE','PROCESSED');
    `);

    // ---- wallet_ledger_entry --------------------------------------------------
    this.addSql(`
      create table "wallet_ledger_entry" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" text not null,
        "amount" numeric(20,2) not null,
        "currency" varchar(3) not null,
        "balance_before" numeric(20,2) not null,
        "balance_after" numeric(20,2) not null,
        "created_at" timestamptz not null default now(),
        constraint "wle_pkey" primary key ("id"),
        constraint "wle_direction_chk" check ("direction" in ('DEBIT','CREDIT')),
        constraint "wle_amount_positive" check ("amount" > 0),
        constraint "wle_balance_before_non_negative" check ("balance_before" >= 0),
        constraint "wle_balance_after_non_negative" check ("balance_after" >= 0),
        constraint "wle_arithmetic_chk" check (
          ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount") or
          ("direction" = 'DEBIT'  and "balance_after" = "balance_before" - "amount")
        ),
        constraint "wle_wallet_fk" foreign key ("wallet_id") references "wallet" ("id"),
        constraint "wle_transaction_fk" foreign key ("transaction_id") references "wager_transaction" ("id")
      );
    `);
    this.addSql(
      `create unique index "wle_wallet_transaction_uq" on "wallet_ledger_entry" ("wallet_id", "transaction_id");`,
    );
    this.addSql(
      `create index "wle_wallet_pagination_idx" on "wallet_ledger_entry" ("wallet_id", "created_at", "id");`,
    );
    // Imutabilidade estrutural: bloqueia UPDATE e DELETE no nível do banco.
    this.addSql(`
      create or replace function "wle_forbid_mutation"() returns trigger as $$
      begin
        raise exception 'wallet_ledger_entry is append-only (attempted %)', tg_op;
      end;
      $$ language plpgsql;
    `);
    this.addSql(`
      create trigger "wle_no_update_delete"
        before update or delete on "wallet_ledger_entry"
        for each row execute function "wle_forbid_mutation"();
    `);

    // ---- inbox_message -----------------------------------------------------
    this.addSql(`
      create table "inbox_message" (
        "consumer_name" text not null,
        "message_id" text not null,
        "payload_hash" text not null,
        "received_at" timestamptz not null default now(),
        "processed_at" timestamptz null,
        constraint "inbox_message_pkey" primary key ("consumer_name", "message_id")
      );
    `);

    // ---- outbox_message --------------------------------------------------------
    this.addSql(`
      create table "outbox_message" (
        "id" uuid not null,
        "aggregate_id" text not null,
        "event_type" text not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null,
        "attempts" int not null default 0,
        "next_attempt_at" timestamptz null,
        "published_at" timestamptz null,
        "created_at" timestamptz not null default now(),
        constraint "outbox_message_pkey" primary key ("id"),
        constraint "outbox_attempts_non_negative" check ("attempts" >= 0)
      );
    `);
    this.addSql(
      `create index "outbox_due_idx" on "outbox_message" ("occurred_at") where "published_at" is null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "outbox_message" cascade;`);
    this.addSql(`drop table if exists "inbox_message" cascade;`);
    this.addSql(`drop trigger if exists "wle_no_update_delete" on "wallet_ledger_entry";`);
    this.addSql(`drop function if exists "wle_forbid_mutation"();`);
    this.addSql(`drop table if exists "wallet_ledger_entry" cascade;`);
    this.addSql(`drop table if exists "wager_transaction" cascade;`);
    this.addSql(`drop table if exists "wallet" cascade;`);
  }
}
