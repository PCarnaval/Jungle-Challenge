import type { SQSClient } from "@aws-sdk/client-sqs";

/**
 * PostgreSQL + LocalStack compartilhados, iniciados uma vez por processo
 * `bun test` via `testcontainers` e derrubados pelo teardown pré-carregado
 * (`bunfig.toml`). `getTestStack()` também espelha os dados de conexão em
 * `process.env` para que `NestFactory.create(AppModule)` → `loadConfig()` os
 * encontre.
 */
export interface TestStack {
  databaseUrl: string;
  aws: { region: string; endpoint: string; accessKeyId: string; secretAccessKey: string };
  sqs: SQSClient;
  queues: { wager: string; dlq: string; events: string };
}

let shared: Promise<{ stack: TestStack; stop: () => Promise<void> }> | null = null;

export async function getTestStack(): Promise<TestStack> {
  shared ??= boot();
  const { stack } = await shared;
  applyEnv(stack);
  return stack;
}

export async function stopTestStack(): Promise<void> {
  if (!shared) return;
  const current = shared;
  shared = null;
  try {
    const { stop } = await current;
    await stop();
  } catch {
    /* O Ryuk recolhe o que sobrar quando o processo terminar. */
  }
}

async function boot(): Promise<{ stack: TestStack; stop: () => Promise<void> }> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const {
    SQSClient,
    CreateQueueCommand,
    GetQueueAttributesCommand,
  } = await import("@aws-sdk/client-sqs");

  const pg = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "wager", POSTGRES_PASSWORD: "wager", POSTGRES_DB: "wager" })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .withStartupTimeout(120_000)
    .start();

  const ls = await new GenericContainer("localstack/localstack:3")
    .withEnvironment({ SERVICES: "sqs", SQS_ENDPOINT_STRATEGY: "path" })
    .withExposedPorts(4566)
    .withWaitStrategy(Wait.forHttp("/_localstack/health", 4566).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();

  const databaseUrl = `postgres://wager:wager@${pg.getHost()}:${pg.getMappedPort(5432)}/wager`;
  const endpoint = `http://${ls.getHost()}:${ls.getMappedPort(4566)}`;
  const aws = { region: "us-east-1", endpoint, accessKeyId: "test", secretAccessKey: "test" };

  const sqs = new SQSClient({
    region: aws.region,
    endpoint,
    credentials: { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey },
  });

  const url = (name: string) => `${endpoint}/000000000000/${name}`;
  const dlqName = "wager-transactions-dlq.fifo";
  const wagerName = "wager-transactions.fifo";
  const eventsName = "wager-events.fifo";

  await sqs.send(
    new CreateQueueCommand({
      QueueName: dlqName,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
    }),
  );
  const dlqArn = (
    await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: url(dlqName), AttributeNames: ["QueueArn"] }),
    )
  ).Attributes?.QueueArn;
  await sqs.send(
    new CreateQueueCommand({
      QueueName: wagerName,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        VisibilityTimeout: "30",
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: "5" }),
      },
    }),
  );
  await sqs.send(
    new CreateQueueCommand({
      QueueName: eventsName,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
    }),
  );

  await applyMigrations(databaseUrl);

  const stack: TestStack = {
    databaseUrl,
    aws,
    sqs,
    queues: { wager: url(wagerName), dlq: url(dlqName), events: url(eventsName) },
  };

  return {
    stack,
    stop: async () => {
      sqs.destroy();
      await Promise.allSettled([pg.stop(), ls.stop()]);
    },
  };
}

async function applyMigrations(databaseUrl: string): Promise<void> {
  const { MikroORM } = await import("@mikro-orm/postgresql");
  const config = (
    await import("../../src/infrastructure/persistence/mikro-orm/mikro-orm.config")
  ).default;
  const orm = await MikroORM.init({ ...config, clientUrl: databaseUrl });
  await orm.getMigrator().up();
  await orm.close(true);
}

function applyEnv(stack: TestStack): void {
  process.env.DATABASE_URL = stack.databaseUrl;
  process.env.AWS_REGION = stack.aws.region;
  process.env.AWS_ENDPOINT_URL = stack.aws.endpoint;
  process.env.AWS_ACCESS_KEY_ID = stack.aws.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = stack.aws.secretAccessKey;
  process.env.SQS_WAGER_QUEUE_URL = stack.queues.wager;
  process.env.SQS_WAGER_DLQ_URL = stack.queues.dlq;
  process.env.SQS_EVENTS_QUEUE_URL = stack.queues.events;
}
