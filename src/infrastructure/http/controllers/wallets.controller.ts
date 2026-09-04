import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import { CreateWallet } from "../../../application/use-cases/create-wallet/create-wallet.use-case";
import { GetWallet } from "../../../application/use-cases/queries/get-wallet.use-case";
import { GetWalletLedger } from "../../../application/use-cases/queries/get-wallet-ledger.use-case";
import { ReconcileWallet } from "../../../application/use-cases/reconcile-wallet/reconcile-wallet.use-case";

import { MetricsService } from "../../observability/metrics.service";
import { AuthGuard } from "../guards/auth.guard";
import { ZodValidationPipe } from "../zod-validation.pipe";
import {
  createWalletSchema,
  ledgerQuerySchema,
  type CreateWalletBody,
  type LedgerQuery,
} from "../dto/schemas";

@UseGuards(AuthGuard)
@Controller("wallets")
export class WalletsController {
  private readonly logger = new Logger("Reconciliation");

  constructor(
    private readonly createWallet: CreateWallet,
    private readonly getWallet: GetWallet,
    private readonly getLedger: GetWalletLedger,
    private readonly reconcile: ReconcileWallet,
    private readonly metrics: MetricsService,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body(new ZodValidationPipe(createWalletSchema)) body: CreateWalletBody) {
    return this.createWallet.execute({
      walletId: body.walletId,
      playerId: body.playerId,
      initialBalance: body.initialBalance,
    });
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string) {
    return this.getWallet.execute(walletId);
  }

  @Get(":walletId/ledger")
  ledger(
    @Param("walletId") walletId: string,
    @Query(new ZodValidationPipe(ledgerQuerySchema)) query: LedgerQuery,
  ) {
    return this.getLedger.execute(walletId, query.cursor ?? null, query.limit);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconcileWallet(@Param("walletId") walletId: string) {
    const view = await this.reconcile.execute(walletId);
    if (!view.consistent) {
      this.metrics.recordReconciliationMismatch();
      this.logger.warn(
        `divergence walletId=${walletId} stored=${view.storedBalance.amount} ` +
          `calculated=${view.calculatedBalance.amount} difference=${view.difference.amount}`,
      );
    }
    return view;
  }
}
