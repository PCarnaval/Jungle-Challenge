#!/bin/sh
# Roda dentro do container do LocalStack assim que o SQS estiver pronto.
# Cria a fila de trabalho FIFO e sua DLQ com uma política de redrive.
set -e

REGION="us-east-1"
ACCOUNT="000000000000"
DLQ_NAME="wager-transactions-dlq.fifo"
QUEUE_NAME="wager-transactions.fifo"
MAX_RECEIVE_COUNT="5"

awslocal sqs create-queue \
  --queue-name "$DLQ_NAME" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

DLQ_ARN="arn:aws:sqs:${REGION}:${ACCOUNT}:${DLQ_NAME}"

awslocal sqs create-queue \
  --queue-name "$QUEUE_NAME" \
  --attributes '{
    "FifoQueue": "true",
    "ContentBasedDeduplication": "false",
    "VisibilityTimeout": "30",
    "RedrivePolicy": "{\"deadLetterTargetArn\":\"'"$DLQ_ARN"'\",\"maxReceiveCount\":\"'"$MAX_RECEIVE_COUNT"'\"}"
  }'

# Eventos de integração de saída publicados pelo relay do outbox transacional.
awslocal sqs create-queue \
  --queue-name "wager-events.fifo" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

echo "SQS queues created: $QUEUE_NAME -> $DLQ_NAME (maxReceiveCount=$MAX_RECEIVE_COUNT), wager-events.fifo"
