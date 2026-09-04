import { MikroORM } from "@mikro-orm/postgresql";
import { uuidv7 } from "uuidv7";

import mikroOrmConfig from "../../src/infrastructure/persistence/mikro-orm/mikro-orm.config";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm/mikro-unit-of-work";
import type { MessagePublisher } from "../../src/application/ports/system.ports";
import type { IntegrationEventEnvelope } from "../../src/domain/messaging/integration-event";
import { CreateWallet } from "../../src/application/use-cases/create-wallet/create-wallet.use-case";
import { ProcessWagerTransaction } from "../../src/application/use-cases/process-wager-transaction/process-wager-transaction.use-case";
import { ReprocessPendingReferences } from "../../src/application/use-cases/reprocess-pending-references/reprocess-pending-references.use-case";
import { PublishOutbox } from "../../src/application/use-cases/publish-outbox/publish-outbox.use-case";

const clock = { now: () => new Date() };
const ids = { next: () => uuidv7() };

/** Registra todo envelope que lhe pedem para publicar (para asserções de publicação duplicada). */
export class RecordingPublisher implements MessagePublisher {
  readonly published: IntegrationEventEnvelope<unknown>[] = [];
  async publish(envelope: IntegrationEventEnvelope<unknown>): Promise<void> {
    this.published.push(envelope);
  }
  get eventIds(): string[] {
    return this.published.map((e) => e.eventId);
  }
}

export interface Instance {
  orm: MikroORM;
  uow: MikroUnitOfWork;
  createWallet: CreateWallet;
  process: ProcessWagerTransaction;
  reprocess: ReprocessPendingReferences;
  publishOutbox: PublishOutbox;
  publisher: RecordingPublisher;
  close(): Promise<void>;
}

/**
 * Um conjunto autossuficiente de use cases sobre seu próprio pool de conexões
 * MikroORM — ou seja, uma "instância" do serviço. Construa várias para modelar
 * N instâncias disputando a mesma wallet através do banco.
 */
export async function buildInstance(
  databaseUrl: string,
  opts: { poolMax?: number; outboxBatchSize?: number } = {},
): Promise<Instance> {
  const orm = await MikroORM.init({
    ...mikroOrmConfig,
    clientUrl: databaseUrl,
    pool: { min: 2, max: opts.poolMax ?? 30 },
  });
  const uow = new MikroUnitOfWork(orm);
  const publisher = new RecordingPublisher();

  return {
    orm,
    uow,
    createWallet: new CreateWallet(uow, clock, ids),
    process: new ProcessWagerTransaction(uow, clock, ids),
    reprocess: new ReprocessPendingReferences(uow, clock, ids, {
      batchSize: 100,
      baseBackoffMs: 0,
      maxAttempts: 5,
      ttlMs: 3_600_000,
    }),
    publishOutbox: new PublishOutbox(uow, publisher, clock, {
      batchSize: opts.outboxBatchSize ?? 200,
      baseBackoffMs: 100,
    }),
    publisher,
    close: () => orm.close(true),
  };
}

export async function walletRow(
  orm: MikroORM,
  walletId: string,
): Promise<{ balance: string; version: number }> {
  const [row] = await orm.em
    .fork()
    .getConnection()
    .execute("select balance, version from wallet where id = ?", [walletId]);
  return row as { balance: string; version: number };
}

export async function ledgerBalance(orm: MikroORM, walletId: string): Promise<string> {
  const [row] = await orm.em
    .fork()
    .getConnection()
    .execute(
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::text as s
         from wallet_ledger_entry where wallet_id = ?`,
      [walletId],
    );
  return (row as { s: string }).s;
}

export async function debitCount(orm: MikroORM, walletId: string): Promise<number> {
  const [row] = await orm.em
    .fork()
    .getConnection()
    .execute(
      "select count(*)::int as n from wallet_ledger_entry where wallet_id = ? and direction = 'DEBIT'",
      [walletId],
    );
  return (row as { n: number }).n;
}

/** Invariante do README item 13: saldo armazenado == saldo reconstruído a partir do ledger. */
export async function assertConsistent(orm: MikroORM, walletId: string): Promise<void> {
  const stored = (await walletRow(orm, walletId)).balance;
  const replayed = await ledgerBalance(orm, walletId);
  if (Number(stored) !== Number(replayed)) {
    throw new Error(
      `wallet ${walletId} inconsistent: stored=${stored} ledger=${replayed}`,
    );
  }
}
