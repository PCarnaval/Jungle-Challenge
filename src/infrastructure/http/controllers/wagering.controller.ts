import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";

import { ValidationError } from "../../../application/application-error";
import type { ResponseLike } from "../http.types";
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionResult,
} from "../../../application/use-cases/process-wager-transaction/process-wager-transaction.use-case";
import { GetWagerTransaction } from "../../../application/use-cases/queries/get-wager-transaction.use-case";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wagering/wager-transaction";

import { MetricsService } from "../../observability/metrics.service";
import { AuthGuard } from "../guards/auth.guard";
import { ZodValidationPipe } from "../zod-validation.pipe";
import { submitTransactionSchema, type SubmitTransactionBody } from "../dto/schemas";

@UseGuards(AuthGuard)
@Controller("wagering/transactions")
export class WageringController {
  constructor(
    private readonly process: ProcessWagerTransaction,
    private readonly getTransaction: GetWagerTransaction,
    private readonly metrics: MetricsService,
  ) {}

  @Post()
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Body(new ZodValidationPipe(submitTransactionSchema)) body: SubmitTransactionBody,
    @Res({ passthrough: true }) res: ResponseLike,
  ): Promise<ProcessWagerTransactionResult> {
    if (!idempotencyKey || idempotencyKey.trim() === "") {
      throw new ValidationError("Idempotency-Key header is required");
    }

    const startedAt = process.hrtime.bigint();
    const result = await this.process.execute({
      idempotencyKey,
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind as WagerTransactionKind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
      correlationId,
    });

    this.metrics.recordTransaction({
      kind: body.kind,
      status: result.status,
      source: "http",
      durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1e9,
      idempotentReplay: result.idempotentReplay,
    });

    res.status(statusForResult(result));
    return result;
  }

  @Get(":transactionId")
  getById(@Param("transactionId") transactionId: string) {
    return this.getTransaction.byId(transactionId);
  }
}

function statusForResult(result: ProcessWagerTransactionResult): number {
  if (result.idempotentReplay) return 200;
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return 201;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
    default:
      return 200;
  }
}
