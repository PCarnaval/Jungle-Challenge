import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { GetWagerTransaction } from "../../../application/use-cases/queries/get-wager-transaction.use-case";
import { AuthGuard } from "../guards/auth.guard";

@UseGuards(AuthGuard)
@Controller("providers/:providerId/wagering/transactions")
export class ProvidersController {
  constructor(private readonly getTransaction: GetWagerTransaction) {}

  @Get(":externalTransactionId")
  getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.getTransaction.byProviderAndExternalId(providerId, externalTransactionId);
  }
}
