import { Inject, Injectable, Logger } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/core";
import { ListQueuesCommand, type SQSClient } from "@aws-sdk/client-sqs";

import { SQS_CLIENT } from "../../application/ports/tokens";

export type CheckState = "up" | "down";

export interface ReadinessResult {
  ready: boolean;
  checks: Record<"postgres" | "sqs", CheckState>;
}

/** Apoia o `GET /health/ready` — alcançabilidade de PostgreSQL e SQS (README item 9). */
@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly orm: MikroORM,
  ) {}

  async check(): Promise<ReadinessResult> {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    return {
      ready: postgres === "up" && sqs === "up",
      checks: { postgres, sqs },
    };
  }

  private async checkPostgres(): Promise<CheckState> {
    try {
      await this.orm.em.getConnection().execute("select 1");
      return "up";
    } catch (err) {
      this.logger.warn(`postgres readiness check failed: ${(err as Error).message}`);
      return "down";
    }
  }

  private async checkSqs(): Promise<CheckState> {
    try {
      await this.sqs.send(new ListQueuesCommand({ MaxResults: 1 }));
      return "up";
    } catch (err) {
      this.logger.warn(`sqs readiness check failed: ${(err as Error).message}`);
      return "down";
    }
  }
}
