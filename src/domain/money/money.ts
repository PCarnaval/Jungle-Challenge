import { Decimal } from "decimal.js";
import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyAmountError,
} from "./money.errors";

/**
 * Construtor Decimal isolado, para que a configuração global de `Decimal` em
 * outro ponto do processo não altere o comportamento de dinheiro. A notação
 * exponencial fica desligada nas duas pontas, então `toFixed` / `toString`
 * nunca emitem `1e3`.
 */
const MoneyDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

/** Escala fixa de todo valor monetário do sistema. */
export const MONEY_SCALE = 2;

/** DTO de transporte — uma interface simples é o adequado aqui (ver README item 6.1). */
export interface MoneyProps {
  /** String decimal, ex.: "25.00". Nunca um number. */
  amount: string;
  /** Código ISO-4217, ex.: "BRL". */
  currency: string;
}

const CURRENCY_RE = /^[A-Z]{3}$/;
/**
 * String decimal simples, não-negativa, com 0–2 casas decimais.
 * Rejeita: string vazia, sinal, notação científica, `NaN`/`Infinity`,
 * mais de 2 casas decimais, espaços.
 */
const AMOUNT_INPUT_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Value object monetário imutável.
 *
 * - `amount` é recebido e serializado como string decimal de escala fixa (2).
 * - Toda operação retorna uma NOVA instância.
 * - Operações entre moedas diferentes lançam um erro de domínio.
 * - O domínio nunca depende de tipos monetários do ORM nem de decorators do NestJS.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  // --------------------------------------------------------------------------
  // Factories
  // --------------------------------------------------------------------------

  /**
   * Factory da fronteira não confiável. Use para tudo que vem da API, da fila
   * ou das colunas do banco. Rejeita valores negativos: contratos de entrada
   * nunca carregam dinheiro negativo (README item 6.1).
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== "object") {
      throw new InvalidMoneyAmountError(props, "not an object");
    }
    const currency = Money.parseCurrency(props.currency);
    const value = Money.parseAmount(props.amount);
    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    return new Money(new MoneyDecimal(0), Money.parseCurrency(currency));
  }

  /**
   * Factory confiável para valores RECONSTRUÍDOS pelo próprio sistema (ex.: um
   * `SUM()` sobre o ledger durante a reconciliação). Ao contrário de {@link from},
   * aceita um `-` à esquerda, para que uma divergência que produziu um saldo
   * reconstruído negativo ainda possa ser representada e reportada. Continua
   * rejeitando `NaN`/`Infinity`, notação científica, string vazia e > 2 casas
   * decimais.
   */
  static fromComputed(props: MoneyProps): Money {
    const currency = Money.parseCurrency(props.currency);
    if (typeof props.amount !== "string" || !/^-?\d+(\.\d{1,2})?$/.test(props.amount)) {
      throw new InvalidMoneyAmountError(props.amount, "invalid computed decimal string");
    }
    const dec = new MoneyDecimal(props.amount);
    if (!dec.isFinite() || dec.decimalPlaces() > MONEY_SCALE) {
      throw new InvalidMoneyAmountError(props.amount, "not finite or too many decimals");
    }
    return new Money(dec, currency);
  }

  // --------------------------------------------------------------------------
  // Aritmética (confiável — os operandos já são instâncias Money validadas)
  // --------------------------------------------------------------------------

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  abs(): Money {
    return new Money(this.value.abs(), this.currency);
  }

  // --------------------------------------------------------------------------
  // Predicados
  // --------------------------------------------------------------------------

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  isGreaterThanOrEqualTo(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThanOrEqualTo(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  // --------------------------------------------------------------------------
  // Serialização
  // --------------------------------------------------------------------------

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(MONEY_SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(MONEY_SCALE)} ${this.currency}`;
  }

  // --------------------------------------------------------------------------
  // Internos
  // --------------------------------------------------------------------------

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(input: unknown): string {
    if (typeof input !== "string" || !CURRENCY_RE.test(input)) {
      throw new InvalidCurrencyError(input);
    }
    return input;
  }

  private static parseAmount(input: unknown): Decimal {
    if (typeof input !== "string") {
      throw new InvalidMoneyAmountError(input, "not a string");
    }
    if (input.length === 0) {
      throw new InvalidMoneyAmountError(input, "empty string");
    }
    if (!AMOUNT_INPUT_RE.test(input)) {
      throw new InvalidMoneyAmountError(
        input,
        "expected a non-negative decimal string with at most 2 fraction digits, no sign, no exponent",
      );
    }
    let dec: Decimal;
    try {
      dec = new MoneyDecimal(input);
    } catch {
      throw new InvalidMoneyAmountError(input, "unparseable");
    }
    if (!dec.isFinite()) {
      throw new InvalidMoneyAmountError(input, "not finite");
    }
    if (dec.decimalPlaces() > MONEY_SCALE) {
      throw new InvalidMoneyAmountError(input, "more than 2 decimal places");
    }
    return dec;
  }
}
