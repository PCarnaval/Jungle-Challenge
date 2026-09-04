import { createHash } from "node:crypto";
import type { Money } from "../domain/money/money";
import type { WagerTransactionKind } from "../domain/wagering/wager-transaction";
import { canonicalJson } from "./canonical-json";

/**
 * O subconjunto de campos de negócio que identifica uma operação de aposta.
 * Metadados de transporte (o header `Idempotency-Key`, `messageId`,
 * `occurredAt`, …) são deliberadamente excluídos — só estes campos decidem
 * replay vs. conflito.
 */
export interface WagerBusinessFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  amount: string; // MoneyProps.amount normalizado (escala fixa 2)
  currency: string;
  referenceExternalTransactionId: string | null;
}

export interface WagerBusinessInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  referenceExternalTransactionId?: string | null;
}

/** Monta o conjunto canônico de campos. `money` já vem parseado e normalizado. */
export function toBusinessFields(input: WagerBusinessInput, money: Money): WagerBusinessFields {
  const m = money.toJSON();
  return {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    amount: m.amount,
    currency: m.currency,
    referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
  };
}

/** SHA-256 (hex) do JSON canônico dos campos de negócio. */
export function hashBusinessFields(fields: WagerBusinessFields): string {
  return createHash("sha256").update(canonicalJson(fields), "utf8").digest("hex");
}
