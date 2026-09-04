import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MessagePublisher } from "../../../application/ports/system.ports";
import type { IntegrationEventEnvelope } from "../../../domain/messaging/integration-event";

/**
 * Publica envelopes de eventos de integração na fila FIFO de saída.
 * `MessageGroupId = aggregateId` mantém a ordem por agregado;
 * `MessageDeduplicationId = eventId` dá dedup no nível do broker por cima da
 * idempotência do próprio consumidor.
 */
export class SqsMessagePublisher implements MessagePublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly eventsQueueUrl: string | undefined,
  ) {}

  async publish(envelope: IntegrationEventEnvelope<unknown>): Promise<void> {
    if (!this.eventsQueueUrl) {
      throw new Error("SQS_EVENTS_QUEUE_URL is not configured; cannot publish integration events");
    }
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.eventsQueueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: envelope.aggregateId,
        MessageDeduplicationId: envelope.eventId,
        MessageAttributes: {
          eventType: { DataType: "String", StringValue: envelope.eventType },
        },
      }),
    );
  }
}
