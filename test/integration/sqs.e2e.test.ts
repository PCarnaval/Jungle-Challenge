import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/core";

import { AppModule } from "../../src/app.module";
import { APP_CONFIG, SQS_CLIENT } from "../../src/application/ports/tokens";
import type { AppConfig } from "../../src/config/app-config";
import { CreateWallet } from "../../src/application/use-cases/create-wallet/create-wallet.use-case";
import { PublishOutbox } from "../../src/application/use-cases/publish-outbox/publish-outbox.use-case";
import { WagerTransactionConsumer } from "../../src/infrastructure/messaging/sqs/wager-transaction.consumer";
import { NestFactory } from "@nestjs/core";
import type { INestApplicationContext } from "@nestjs/common";

import { getTestStack } from "../support/containers";

const uid = (): string => crypto.randomUUID();

let ctx: INestApplicationContext;
let sqs: SQSClient;
let orm: MikroORM;
let config: AppConfig;
let createWallet: CreateWallet;
let consumer: WagerTransactionConsumer;
let relay: PublishOutbox;

const send = (queueUrl: string, body: unknown, dedupId: string, groupId: string) =>
  sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: dedupId,
    }),
  );

const receiveAll = async (queueUrl: string) => {
  const out = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageAttributeNames: ["All"],
    }),
  );
  return out.Messages ?? [];
};

const wagerMsg = (opts: {
  messageId?: string;
  walletId: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  kind?: string;
  amount?: string;
  reference?: string;
}) => {
  const ext = opts.externalTransactionId ?? uid();
  return {
    messageId: opts.messageId ?? uid(),
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-a",
      externalTransactionId: ext,
      idempotencyKey: opts.idempotencyKey ?? `provider-a:${ext}`,
      playerId: uid(),
      walletId: opts.walletId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: opts.kind ?? "BET",
      money: { amount: opts.amount ?? "25.00", currency: "BRL" },
      ...(opts.reference ? { referenceExternalTransactionId: opts.reference } : {}),
    },
  };
};

const row = async <T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T> => {
  const rows = await orm.em.fork().getConnection().execute(sql, params);
  return rows[0] as T;
};

beforeAll(async () => {
  await getTestStack();
  process.env.WORKER = "api"; // aciona o consumidor / relay manualmente
  process.env.SQS_WAIT_TIME_SECONDS = "0";
  process.env.CONSUMER_NAME = "test-consumer";
  ctx = await NestFactory.createApplicationContext(AppModule, { logger: false });
  sqs = ctx.get(SQS_CLIENT);
  orm = ctx.get(MikroORM);
  config = ctx.get(APP_CONFIG);
  createWallet = ctx.get(CreateWallet);
  consumer = ctx.get(WagerTransactionConsumer);
  relay = ctx.get(PublishOutbox);

  await orm.em
    .getConnection()
    .execute(
      "truncate wallet, wager_transaction, wallet_ledger_entry, inbox_message, outbox_message cascade",
    );
}, 180_000);

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  for (const url of [config.sqs.queueUrl, config.sqs.dlqUrl, config.sqs.eventsQueueUrl]) {
    if (url) await sqs.send(new PurgeQueueCommand({ QueueUrl: url })).catch(() => undefined);
  }
});

describe("SQS consumer + outbox relay (e2e)", () => {
  it("consumes a BET: wallet debited, inbox row, transaction PROCESSED, outbox events", async () => {
    const w = await createWallet.execute({
      playerId: uid(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const msg = wagerMsg({ walletId: w.id, amount: "30.00", messageId: "msg-consume-1" });
    await send(config.sqs.queueUrl!, msg, uid(), w.id);

    const result = await consumer.pollOnce();
    expect(result).toMatchObject({ received: 1, acked: 1, dlq: 0, retried: 0 });

    const wallet = await row<{ balance: string }>("select balance from wallet where id = ?", [w.id]);
    expect(wallet.balance).toBe("70.00");

    const inbox = await row<{ n: string }>(
      "select count(*) n from inbox_message where consumer_name = ? and message_id = ?",
      ["test-consumer", "msg-consume-1"],
    );
    expect(inbox.n).toBe("1");

    const tx = await row<{ status: string; id: string }>(
      "select id, status from wager_transaction where wallet_id = ? and kind = 'BET'",
      [w.id],
    );
    expect(tx.status).toBe("PROCESSED");

    const events = await orm.em
      .fork()
      .getConnection()
      .execute("select event_type from outbox_message where aggregate_id in (?, ?)", [w.id, tx.id]);
    const types = events.map((e: { event_type: string }) => e.event_type);
    expect(types).toContain("WagerTransactionProcessed");
    expect(types).toContain("WalletBalanceChanged");
  });

  it("redelivery of the same messageId is deduped by the inbox — no second debit", async () => {
    const w = await createWallet.execute({
      playerId: uid(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const msg = wagerMsg({ walletId: w.id, amount: "40.00", messageId: "msg-dedupe-1" });

    await send(config.sqs.queueUrl!, msg, uid(), w.id);
    expect(await consumer.pollOnce()).toMatchObject({ acked: 1 });

    // mesmo corpo (mesmo messageId), novo dedup id do SQS → entregue de novo
    await send(config.sqs.queueUrl!, msg, uid(), w.id);
    expect(await consumer.pollOnce()).toMatchObject({ received: 1, acked: 1 });

    const wallet = await row<{ balance: string }>("select balance from wallet where id = ?", [w.id]);
    expect(wallet.balance).toBe("60.00");

    const debits = await row<{ n: string }>(
      "select count(*) n from wallet_ledger_entry where wallet_id = ? and direction = 'DEBIT'",
      [w.id],
    );
    expect(debits.n).toBe("1");
  });

  it("a business rejection is acked (persisted REJECTED), not retried", async () => {
    const w = await createWallet.execute({
      playerId: uid(),
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    await send(
      config.sqs.queueUrl!,
      wagerMsg({ walletId: w.id, amount: "80.00", messageId: uid() }),
      uid(),
      w.id,
    );
    expect(await consumer.pollOnce()).toMatchObject({ acked: 1, retried: 0, dlq: 0 });

    const tx = await row<{ status: string; failure_code: string }>(
      "select status, failure_code from wager_transaction where wallet_id = ? and kind = 'BET'",
      [w.id],
    );
    expect(tx.status).toBe("REJECTED");
    expect(tx.failure_code).toBe("INSUFFICIENT_FUNDS");
  });

  it("a malformed message is moved to the DLQ and removed from the source", async () => {
    await send(config.sqs.queueUrl!, { not: "a wager message" }, uid(), "bad");

    const result = await consumer.pollOnce();
    expect(result).toMatchObject({ received: 1, dlq: 1 });

    const dead = await receiveAll(config.sqs.dlqUrl!);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.MessageAttributes?.failureReason?.StringValue).toContain("parse_error");
  });

  it("the outbox relay publishes pending events to the events queue and marks them published", async () => {
    const w = await createWallet.execute({
      playerId: uid(),
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    await send(
      config.sqs.queueUrl!,
      wagerMsg({ walletId: w.id, amount: "15.00", messageId: uid() }),
      uid(),
      w.id,
    );
    await consumer.pollOnce();

    const before = await row<{ n: string }>(
      "select count(*) n from outbox_message where published_at is null",
      [],
    );
    expect(Number(before.n)).toBeGreaterThan(0);

    const summary = await relay.execute();
    expect(summary.published).toBe(Number(before.n));
    expect(summary.retried).toBe(0);

    const after = await row<{ n: string }>(
      "select count(*) n from outbox_message where published_at is null",
      [],
    );
    expect(after.n).toBe("0");

    const events = await receiveAll(config.sqs.eventsQueueUrl!);
    const types = events.map((m) => JSON.parse(m.Body ?? "{}").eventType);
    expect(types).toContain("WagerTransactionProcessed");
    expect(types).toContain("WalletBalanceChanged");
  });
});
