import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { getTestStack } from "../support/containers";
import {
  assertConsistent,
  buildInstance,
  debitCount,
  ledgerBalance,
  walletRow,
  type Instance,
} from "../support/build-use-cases";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wagering/wager-transaction";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import type { ProcessWagerTransactionCommand } from "../../src/application/use-cases/process-wager-transaction/process-wager-transaction.use-case";

const uid = (): string => crypto.randomUUID();

const sql = async <T>(inst: Instance, query: string, params: unknown[] = []): Promise<T[]> =>
  inst.orm.em.fork().getConnection().execute(query, params) as Promise<T[]>;

let stackUrl: string;
let main: Instance;

beforeAll(async () => {
  const stack = await getTestStack();
  stackUrl = stack.databaseUrl;
  main = await buildInstance(stackUrl, { poolMax: 60 });
}, 180_000);

afterAll(async () => {
  await main?.close();
});

beforeEach(async () => {
  await main.orm.em
    .getConnection()
    .execute(
      "truncate wallet, wager_transaction, wallet_ledger_entry, inbox_message, outbox_message cascade",
    );
});

async function openWallet(amount: string): Promise<string> {
  const r = await main.createWallet.execute({
    playerId: uid(),
    initialBalance: { amount, currency: "BRL" },
  });
  return r.id;
}

function betCommand(walletId: string, over: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand {
  const ext = (over.externalTransactionId as string) ?? uid();
  return {
    idempotencyKey: over.idempotencyKey ?? `provider-a:${ext}`,
    providerId: "provider-a",
    externalTransactionId: ext,
    playerId: uid(),
    walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: { amount: "10.00", currency: "BRL" },
    ...over,
  };
}

describe("concurrency (real parallelism, real Postgres)", () => {
  it("the same bet sent 50× in parallel produces exactly one debit", async () => {
    const walletId = await openWallet("100.00");
    const command = betCommand(walletId, {
      externalTransactionId: "bet-1",
      money: { amount: "40.00", currency: "BRL" },
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => main.process.execute({ ...command })),
    );

    const applied = results.filter((r) => !r.idempotentReplay);
    expect(applied).toHaveLength(1);
    expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(results.every((r) => r.transactionId === applied[0]!.transactionId)).toBe(true);

    expect(await debitCount(main.orm, walletId)).toBe(1);
    expect((await walletRow(main.orm, walletId)).balance).toBe("60.00");
    await assertConsistent(main.orm, walletId);
  });

  it("§8 mandatory scenario: two 80.00 bets on 100.00 → one PROCESSED, one REJECTED, one debit", async () => {
    const walletId = await openWallet("100.00");

    const [a, b] = await Promise.all([
      main.process.execute(
        betCommand(walletId, { externalTransactionId: "A", money: { amount: "80.00", currency: "BRL" } }),
      ),
      main.process.execute(
        betCommand(walletId, { externalTransactionId: "B", money: { amount: "80.00", currency: "BRL" } }),
      ),
    ]);

    expect([a.status, b.status].sort()).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ]);
    const rejected = [a, b].find((r) => r.status === WagerTransactionStatus.Rejected)!;
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);

    expect(await debitCount(main.orm, walletId)).toBe(1);
    expect((await walletRow(main.orm, walletId)).balance).toBe("20.00");
    await assertConsistent(main.orm, walletId);
  });

  it("a hot wallet under 10 concurrent bets never goes negative", async () => {
    const walletId = await openWallet("100.00");

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        main.process.execute(
          betCommand(walletId, {
            externalTransactionId: `hot-${i}`,
            money: { amount: "15.00", currency: "BRL" },
          }),
        ),
      ),
    );

    const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed);
    expect(processed).toHaveLength(6); // floor(100 / 15)
    expect((await walletRow(main.orm, walletId)).balance).toBe("10.00");
    expect(Number(await ledgerBalance(main.orm, walletId))).toBeGreaterThanOrEqual(0);
    await assertConsistent(main.orm, walletId);
  });

  it("distinct wallets are processed in parallel without cross-effects", async () => {
    const wallets = await Promise.all(Array.from({ length: 15 }, () => openWallet("50.00")));

    await Promise.all(
      wallets.map((walletId) =>
        main.process.execute(
          betCommand(walletId, { money: { amount: "20.00", currency: "BRL" } }),
        ),
      ),
    );

    for (const walletId of wallets) {
      expect((await walletRow(main.orm, walletId)).balance).toBe("30.00");
      expect(await debitCount(main.orm, walletId)).toBe(1);
      await assertConsistent(main.orm, walletId);
    }
  });

  it("three independent instances contend on one wallet through the DB lock", async () => {
    const walletId = await openWallet("100.00");
    const instances = await Promise.all([
      buildInstance(stackUrl, { poolMax: 15 }),
      buildInstance(stackUrl, { poolMax: 15 }),
      buildInstance(stackUrl, { poolMax: 15 }),
    ]);

    try {
      const results = await Promise.all(
        instances.flatMap((inst, n) =>
          Array.from({ length: 10 }, (_, i) =>
            inst.process.execute(
              betCommand(walletId, {
                externalTransactionId: `i${n}-${i}`,
                money: { amount: "5.00", currency: "BRL" },
              }),
            ),
          ),
        ),
      );

      const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed);
      expect(processed).toHaveLength(20); // 100 / 5
      expect((await walletRow(main.orm, walletId)).balance).toBe("0.00");
      expect(await debitCount(main.orm, walletId)).toBe(20);
      await assertConsistent(main.orm, walletId);
    } finally {
      await Promise.all(instances.map((i) => i.close()));
    }
  });

  it("crash after commit / before ack: a redelivery replays without a second effect", async () => {
    const walletId = await openWallet("100.00");
    const messageId = "msg-crash-1";
    const command = betCommand(walletId, {
      externalTransactionId: "crash-1",
      money: { amount: "30.00", currency: "BRL" },
      inbox: { consumerName: "c1", messageId, payloadHash: "hash-1" },
    });

    // commitou e então o processo "morre" antes de apagar a mensagem do SQS
    const first = await main.process.execute({ ...command });
    expect(first.status).toBe(WagerTransactionStatus.Processed);

    // o SQS re-entrega a mesma mensagem
    const redelivered = await main.process.execute({ ...command });
    expect(redelivered.idempotentReplay).toBe(true);
    expect(redelivered.transactionId).toBe(first.transactionId);

    expect(await debitCount(main.orm, walletId)).toBe(1);
    expect((await walletRow(main.orm, walletId)).balance).toBe("70.00");
    await assertConsistent(main.orm, walletId);
  });

  it("two publishers drain the same outbox with no lost or duplicate publish", async () => {
    const walletId = await openWallet("1000.00");
    for (let i = 0; i < 6; i++) {
      await main.process.execute(
        betCommand(walletId, { externalTransactionId: `p-${i}`, money: { amount: "10.00", currency: "BRL" } }),
      );
    }
    const [pendingRow] = await sql<{ n: number }>(
      main,
      "select count(*)::int n from outbox_message where published_at is null",
    );
    const pending = pendingRow!.n;
    expect(pending).toBeGreaterThan(0);

    const p1 = await buildInstance(stackUrl, { poolMax: 10, outboxBatchSize: 3 });
    const p2 = await buildInstance(stackUrl, { poolMax: 10, outboxBatchSize: 3 });
    try {
      const runAll = async (inst: Instance) => {
        let total = 0;
        for (;;) {
          const s = await inst.publishOutbox.execute();
          total += s.published;
          if (s.claimed === 0) return total;
        }
      };
      const [a, b] = await Promise.all([runAll(p1), runAll(p2)]);

      expect(a + b).toBe(pending);
      const ids = [...p1.publisher.eventIds, ...p2.publisher.eventIds];
      expect(ids).toHaveLength(pending);
      expect(new Set(ids).size).toBe(pending); // nenhum eventId publicado duas vezes

      const [leftRow] = await sql<{ n: number }>(
        main,
        "select count(*)::int n from outbox_message where published_at is null",
      );
      expect(leftRow!.n).toBe(0);
    } finally {
      await Promise.all([p1.close(), p2.close()]);
    }
  });

  it("a REFUND delivered before its BET is resolved by the reprocessor", async () => {
    const walletId = await openWallet("100.00");
    const playerId = uid(); // o refund e sua bet precisam compartilhar player / round / currency

    const [refund] = await Promise.all([
      main.process.execute(
        betCommand(walletId, {
          playerId,
          externalTransactionId: "refund-1",
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: "bet-late",
          money: { amount: "30.00", currency: "BRL" },
        }),
      ),
      main.process.execute(
        betCommand(walletId, {
          playerId,
          externalTransactionId: "bet-late",
          money: { amount: "30.00", currency: "BRL" },
        }),
      ),
    ]);

    // o refund chegou na frente da bet → adiado
    expect([WagerTransactionStatus.PendingReference, WagerTransactionStatus.Processed]).toContain(
      refund.status,
    );

    // varre até não haver mais nada pendente
    for (let i = 0; i < 5; i++) {
      const s = await main.reprocess.execute();
      if (s.scanned === 0) break;
    }

    const [refundRow] = await sql<{ status: string }>(
      main,
      "select status from wager_transaction where external_transaction_id = 'refund-1'",
    );
    expect(refundRow!.status).toBe("PROCESSED");
    expect((await walletRow(main.orm, walletId)).balance).toBe("100.00");
    await assertConsistent(main.orm, walletId);
  });

  it("survives a restart with final ledger consistency", async () => {
    const walletId = await openWallet("200.00");
    for (let i = 0; i < 5; i++) {
      await main.process.execute(
        betCommand(walletId, { externalTransactionId: `r-${i}`, money: { amount: "10.00", currency: "BRL" } }),
      );
    }

    // "reinício": descarta o pool, reconecta
    const restarted = await buildInstance(stackUrl, { poolMax: 5 });
    try {
      expect((await walletRow(restarted.orm, walletId)).balance).toBe("150.00");
      await assertConsistent(restarted.orm, walletId);

      // e continua funcionando
      await restarted.process.execute(
        betCommand(walletId, { externalTransactionId: "after-restart", money: { amount: "50.00", currency: "BRL" } }),
      );
      expect((await walletRow(restarted.orm, walletId)).balance).toBe("100.00");
      await assertConsistent(restarted.orm, walletId);
    } finally {
      await restarted.close();
    }
  });
});
