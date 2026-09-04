import { Money, type MoneyProps } from "../../../domain/money/money";
import { DomainError } from "../../../domain/shared/domain-error";
import { Wallet } from "../../../domain/wallet/wallet";
import { WagerTransaction } from "../../../domain/wagering/wager-transaction";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../../../domain/messaging/events";
import type { EventContext } from "../../../domain/messaging/integration-event";
import { OutboxMessage } from "../../../domain/messaging/outbox-message";

import { ValidationError, WalletAlreadyExistsError } from "../../application-error";
import type { Clock, IdGenerator } from "../../ports/system.ports";
import { UniqueConstraintError, type UnitOfWork } from "../../ports/unit-of-work.port";

export interface CreateWalletCommand {
  /** Id opcional fornecido pelo cliente; gerado quando ausente. */
  walletId?: string;
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/**
 * Abre uma wallet. Quando o saldo de abertura é positivo, uma transação interna
 * `OPENING` e o seu lançamento `CREDIT` são escritos na MESMA transação SQL
 * (README item 9), mantendo `balance == replay(ledger)` desde o início.
 */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    let initialBalance: Money;
    try {
      initialBalance = Money.from(command.initialBalance);
    } catch (err) {
      throw new ValidationError(
        err instanceof DomainError ? err.message : "Invalid initialBalance",
      );
    }

    const now = this.clock.now();
    const walletId = command.walletId ?? this.ids.next();
    const currency = initialBalance.currency;
    const correlationId = command.correlationId ?? this.ids.next();

    return this.uow.run({ name: "create-wallet" }, async (repos) => {
      const existing = await repos.wallets.findByPlayerAndCurrency(command.playerId, currency);
      if (existing) {
        throw new WalletAlreadyExistsError(command.playerId, currency);
      }

      const wallet = Wallet.open({
        id: walletId,
        playerId: command.playerId,
        initialBalance,
        now,
      });

      try {
        await repos.wallets.insert(wallet);
      } catch (err) {
        if (err instanceof UniqueConstraintError) {
          throw new WalletAlreadyExistsError(command.playerId, currency);
        }
        throw err;
      }

      if (wallet.hasOpeningBalance()) {
        const opening = WagerTransaction.opening({
          id: this.ids.next(),
          walletId,
          playerId: command.playerId,
          money: initialBalance,
          createdAt: now,
        });
        const entry = wallet.openingLedgerEntry({
          transactionId: opening.id,
          ledgerEntryId: this.ids.next(),
          at: now,
        });
        // hasOpeningBalance() é true, então `entry` está sempre definido aqui.
        if (!entry) throw new Error("unreachable: opening balance without ledger entry");

        opening.markProcessed(undefined, now);
        opening.recordObservedBalance(wallet.balance);

        await repos.transactions.insert(opening);
        await repos.ledger.insert(entry);

        const ctx = (): EventContext => ({
          eventId: this.ids.next(),
          correlationId,
          occurredAt: now,
        });
        await repos.outbox.insertMany([
          OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx())),
          OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx())),
        ]);
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
