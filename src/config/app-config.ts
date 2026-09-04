import { z } from "zod";

const ConfigSchema = z.object({
  nodeEnv: z.string().default("development"),
  httpPort: z.coerce.number().int().positive().default(3000),
  
  worker: z.enum(["api", "consumer", "outbox", "pending-reference", "all"]).default("all"),
  logLevel: z.string().default("info"),
  databaseUrl: z.string().min(1),
  aws: z.object({
    region: z.string().default("us-east-1"),
    endpoint: z.string().optional(),
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
  }),
  sqs: z.object({
    queueUrl: z.string().optional(),
    dlqUrl: z.string().optional(),
    eventsQueueUrl: z.string().optional(),
  }),
  consumer: z.object({
    name: z.string().default("wager-consumer"),
    maxMessages: z.coerce.number().int().min(1).max(10).default(10),
    waitTimeSeconds: z.coerce.number().int().min(0).max(20).default(20),
    visibilityTimeoutSeconds: z.coerce.number().int().min(1).default(30),
  }),
  outbox: z.object({
    batchSize: z.coerce.number().int().min(1).default(50),
    pollIntervalMs: z.coerce.number().int().min(100).default(1000),
    baseBackoffMs: z.coerce.number().int().min(1).default(500),
  }),
  auth: z
    .object({
     
      mode: z.enum(["none", "hmac"]).default("none"),
      providerSecrets: z.record(z.string(), z.string()).default({}),
      hmacTimestampToleranceSeconds: z.coerce.number().int().positive().default(300),
    })
    .refine((a) => a.mode === "none" || Object.keys(a.providerSecrets).length > 0, {
      message: "AUTH_MODE=hmac requires PROVIDER_SECRETS with at least one provider",
    }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type WorkerRole = AppConfig["worker"];


export function workerEnabled(
  worker: WorkerRole,
  name: "consumer" | "outbox" | "pending-reference",
): boolean {
  return worker === "all" || worker === name;
}

function parseSecrets(raw: string | undefined): Record<string, string> | undefined {
  if (!raw || raw.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
  
  }
  throw new Error("PROVIDER_SECRETS must be a JSON object of { providerId: secret }");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return ConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    httpPort: env.HTTP_PORT,
    worker: env.WORKER,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL ?? "postgres://wager:wager@localhost:5432/wager",
    aws: {
      region: env.AWS_REGION,
      endpoint: env.AWS_ENDPOINT_URL,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
    sqs: {
      queueUrl: env.SQS_WAGER_QUEUE_URL,
      dlqUrl: env.SQS_WAGER_DLQ_URL,
      eventsQueueUrl: env.SQS_EVENTS_QUEUE_URL,
    },
    consumer: {
      name: env.CONSUMER_NAME,
      maxMessages: env.SQS_MAX_MESSAGES,
      waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
      visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT_SECONDS,
    },
    outbox: {
      batchSize: env.OUTBOX_BATCH_SIZE,
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      baseBackoffMs: env.OUTBOX_BASE_BACKOFF_MS,
    },
    auth: {
      mode: env.AUTH_MODE,
      providerSecrets: parseSecrets(env.PROVIDER_SECRETS),
      hmacTimestampToleranceSeconds: env.HMAC_TIMESTAMP_TOLERANCE_SECONDS,
    },
  });
}
