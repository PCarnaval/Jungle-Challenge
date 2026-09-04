import { createHash } from "node:crypto";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";

import { ApplicationError } from "../../../application/application-error";
import { TransientInfrastructureError } from "../../../application/ports/unit-of-work.port";
import { canonicalJson } from "../../../application/canonical-json";
import { ProcessWagerTransaction } from "../../../application/use-cases/process-wager-transaction/process-wager-transaction.use-case";
import type { WagerTransactionKind } from "../../../domain/wagering/wager-transaction";
import { workerEnabled, type AppConfig } from "../../../config/app-config";
import { MetricsService } from "../../observability/metrics.service";
import { wagerMessageSchema } from "./wager-message.schema";

export interface ConsumerConfig {
  queueUrl: string | undefined;
  dlqUrl: string | undefined;
  consumerName: string;
  maxMessages: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
}

export interface PollResult {
  received: number;
  acked: number;
  dlq: number;
  retried: number;
}

type Handled = "acked" | "dlq" | "retried";

/**
 * Consumidor SQS de `WagerTransactionRequested`. Reusa o mesmo use case
 * `ProcessWagerTransaction` do endpoint HTTP (README item 10); a linha do inbox
 * (`consumerName, messageId`) é escrita na mesma transação SQL.
 *
 *  - sucesso (inclusive um REJECTED persistido) → delete (ack)
 *  - falha transitória                          → deixa a mensagem; o SQS
 *                                                 re-entrega, redrive → DLQ após
 *                                                 maxReceiveCount
 *  - permanente / malformada                    → copia para a DLQ + delete
 *
 * O `ack` só acontece depois que a transação do banco commitou.
 */
@Injectable()
export class WagerTransactionConsumer implements OnModuleInit, OnModuleDestroy {
  private stopping = false;
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sqs: SQSClient,
    private readonly process: ProcessWagerTransaction,
    private readonly config: ConsumerConfig,
    private readonly appConfig: AppConfig,
    private readonly logger: PinoLogger,
    private readonly metrics?: MetricsService,
  ) {
    this.logger.setContext(WagerTransactionConsumer.name);
  }

  onModuleInit(): void {
    if (!workerEnabled(this.appConfig.worker, "consumer")) return;
    if (!this.config.queueUrl) {
      this.logger.warn("SQS_WAGER_QUEUE_URL not set — consumer disabled");
      return;
    }
    this.logger.info(
      { queueUrl: this.config.queueUrl, consumerName: this.config.consumerName },
      "consumer started",
    );
    void this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.inFlight; // deixa o batch atual terminar (ou as mensagens dele voltarem para a fila)
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        this.inFlight = this.pollOnce();
        await this.inFlight;
      } catch (err) {
        this.logger.error({ err: (err as Error).message }, "poll loop error");
        await delay(1000);
      }
    }
    this.logger.info("consumer stopped");
  }

  /** Um ciclo de receive + handle. Exposto para testes determinísticos. */
  async pollOnce(): Promise<PollResult> {
    const received = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.config.queueUrl,
        MaxNumberOfMessages: this.config.maxMessages,
        WaitTimeSeconds: this.config.waitTimeSeconds,
        VisibilityTimeout: this.config.visibilityTimeoutSeconds,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );

    const messages = received.Messages ?? [];
    const result: PollResult = { received: messages.length, acked: 0, dlq: 0, retried: 0 };

    for (const message of messages) {
      if (this.stopping) break;
      const outcome = await this.handle(message);
      result[outcome] += 1;
    }
    return result;
  }

  private async handle(message: Message): Promise<Handled> {
    const parsed = safeParse(message.Body);
    if (!parsed.ok) {
      this.logger.warn(
        { sqsMessageId: message.MessageId, error: parsed.error },
        "unparseable message routed to DLQ",
      );
      this.metrics?.recordDlq("parse_error");
      await this.toDlq(message, `parse_error: ${parsed.error}`, "unparseable");
      return "dlq";
    }

    const { messageId, data } = parsed.value;
    const log = this.logger.logger.child({
      correlationId: messageId,
      messageId,
      walletId: data.walletId,
      providerId: data.providerId,
    });
    const startedAt = process.hrtime.bigint();
    try {
      const result = await this.process.execute({
        idempotencyKey: data.idempotencyKey,
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind as WagerTransactionKind,
        money: data.money,
        referenceExternalTransactionId: data.referenceExternalTransactionId,
        correlationId: messageId,
        inbox: {
          consumerName: this.config.consumerName,
          messageId,
          payloadHash: sha256(canonicalJson(data)),
        },
      });
      this.metrics?.recordTransaction({
        kind: data.kind,
        status: result.status,
        source: "sqs",
        durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1e9,
        idempotentReplay: result.idempotentReplay,
      });
      if (result.idempotentReplay) this.metrics?.recordDuplicate("inbox");
      log.info(
        { transactionId: result.transactionId, status: result.status, replay: result.idempotentReplay },
        "message processed",
      );
      await this.ack(message);
      return "acked";
    } catch (err) {
      if (isTransient(err)) {
        this.metrics?.recordRetries("consumer", 1);
        log.warn({ error: (err as Error).message }, "transient error; leaving for redelivery");
        return "retried";
      }
      this.metrics?.recordDlq("permanent");
      log.warn({ error: (err as Error).message }, "permanent error routed to DLQ");
      await this.toDlq(message, `permanent: ${(err as Error).message}`, data.walletId);
      return "dlq";
    }
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.config.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private async toDlq(message: Message, reason: string, groupId: string): Promise<void> {
    if (this.config.dlqUrl) {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.config.dlqUrl,
          MessageBody: message.Body ?? "",
          MessageGroupId: groupId,
          MessageDeduplicationId: message.MessageId ?? sha256(message.Body ?? reason),
          MessageAttributes: {
            failureReason: { DataType: "String", StringValue: reason.slice(0, 250) },
          },
        }),
      );
    }
    await this.ack(message);
  }
}

function isTransient(err: unknown): boolean {
  if (err instanceof TransientInfrastructureError) return true;
  if (err instanceof ApplicationError) return err.kind === "transient";
  // Erros desconhecidos: assume transitório para que nenhum dado seja
  // descartado em silêncio — o redrive do SQS manda para a DLQ após
  // maxReceiveCount se continuar falhando.
  return true;
}

type ParseOutcome =
  | { ok: true; value: import("./wager-message.schema").WagerMessage }
  | { ok: false; error: string };

function safeParse(body: string | undefined): ParseOutcome {
  try {
    const json = JSON.parse(body ?? "");
    const result = wagerMessageSchema.safeParse(json);
    if (!result.success) {
      return { ok: false, error: result.error.issues.map((i) => i.message).join("; ") };
    }
    return { ok: true, value: result.data };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

const sha256 = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
