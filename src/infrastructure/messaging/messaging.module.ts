import { Module } from "@nestjs/common";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { PinoLogger } from "nestjs-pino";

import { ApplicationModule } from "../../application/application.module";
import {
  APP_CONFIG,
  CLOCK,
  MESSAGE_PUBLISHER,
  SQS_CLIENT,
  UNIT_OF_WORK,
} from "../../application/ports/tokens";
import type { Clock, MessagePublisher } from "../../application/ports/system.ports";
import type { UnitOfWork } from "../../application/ports/unit-of-work.port";
import { ProcessWagerTransaction } from "../../application/use-cases/process-wager-transaction/process-wager-transaction.use-case";
import { PublishOutbox } from "../../application/use-cases/publish-outbox/publish-outbox.use-case";
import type { AppConfig } from "../../config/app-config";
import { MetricsService } from "../observability/metrics.service";

import { createSqsClient } from "./sqs/sqs-client.factory";
import { SqsMessagePublisher } from "./sqs/sqs-message-publisher";
import { WagerTransactionConsumer } from "./sqs/wager-transaction.consumer";
import { OutboxRelayWorker } from "./outbox/outbox-relay.worker";

@Module({
  imports: [ApplicationModule],
  providers: [
    {
      provide: SQS_CLIENT,
      useFactory: (config: AppConfig) => createSqsClient(config),
      inject: [APP_CONFIG],
    },
    {
      provide: MESSAGE_PUBLISHER,
      useFactory: (sqs: SQSClient, config: AppConfig, metrics: MetricsService) =>
        new SqsMessagePublisher(sqs, config.sqs.eventsQueueUrl, metrics),
      inject: [SQS_CLIENT, APP_CONFIG, MetricsService],
    },
    {
      provide: PublishOutbox,
      useFactory: (uow: UnitOfWork, publisher: MessagePublisher, clock: Clock, config: AppConfig) =>
        new PublishOutbox(uow, publisher, clock, {
          batchSize: config.outbox.batchSize,
          baseBackoffMs: config.outbox.baseBackoffMs,
        }),
      inject: [UNIT_OF_WORK, MESSAGE_PUBLISHER, CLOCK, APP_CONFIG],
    },
    {
      provide: WagerTransactionConsumer,
      useFactory: (
        sqs: SQSClient,
        process: ProcessWagerTransaction,
        config: AppConfig,
        logger: PinoLogger,
        metrics: MetricsService,
      ) =>
        new WagerTransactionConsumer(
          sqs,
          process,
          {
            queueUrl: config.sqs.queueUrl,
            dlqUrl: config.sqs.dlqUrl,
            consumerName: config.consumer.name,
            maxMessages: config.consumer.maxMessages,
            waitTimeSeconds: config.consumer.waitTimeSeconds,
            visibilityTimeoutSeconds: config.consumer.visibilityTimeoutSeconds,
          },
          config,
          logger,
          metrics,
        ),
      inject: [SQS_CLIENT, ProcessWagerTransaction, APP_CONFIG, PinoLogger, MetricsService],
    },
    {
      provide: OutboxRelayWorker,
      useFactory: (relay: PublishOutbox, config: AppConfig, metrics: MetricsService) =>
        new OutboxRelayWorker(relay, config, config.outbox.pollIntervalMs, metrics),
      inject: [PublishOutbox, APP_CONFIG, MetricsService],
    },
  ],
  exports: [MESSAGE_PUBLISHER, SQS_CLIENT, PublishOutbox, WagerTransactionConsumer, OutboxRelayWorker],
})
export class MessagingModule {}
