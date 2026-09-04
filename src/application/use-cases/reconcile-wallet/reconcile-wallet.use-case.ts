import type { MoneyProps } from "../../../domain/money/money";
import { WalletNotFoundError } from "../../application-error";
import type { UnitOfWork } from "../../ports/unit-of-work.port";

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** Observer de divergências — o item 9 do enunciado exige log + métrica, nunca uma correção silenciosa. */
export interface ReconciliationObserver {
  onDivergence(view: ReconciliationView): void;
}

/**
 * Compara o saldo materializado da wallet com a soma do seu ledger.
 * Roda sob o lock da wallet, para que nenhuma escrita se intercale entre as
 * duas leituras. Divergências são reportadas, nunca corrigidas aqui.
 */
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly observer?: ReconciliationObserver,
  ) {}

  async execute(walletId: string): Promise<ReconciliationView> {
    const view = await this.uow.run(
      { lockWallet: walletId, name: "reconcile-wallet" },
      async (repos): Promise<ReconciliationView> => {
        const wallet = await repos.wallets.findById(walletId);
        if (!wallet) throw new WalletNotFoundError(walletId);

        const stored = wallet.balance;
        const calculated = await repos.ledger.sumSignedByWallet(walletId);
        const difference = stored.subtract(calculated);
        const checkedEntries = await repos.ledger.countByWallet(walletId);

        return {
          walletId,
          storedBalance: stored.toJSON(),
          calculatedBalance: calculated.toJSON(),
          difference: difference.toJSON(),
          consistent: difference.isZero(),
          checkedEntries,
        };
      },
    );

    if (!view.consistent) {
      this.observer?.onDivergence(view);
    }
    return view;
  }
}
