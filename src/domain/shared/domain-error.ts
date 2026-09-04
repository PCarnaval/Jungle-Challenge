/**
 * Classe base de todo erro que representa uma regra de domínio violada.
 *
 * Falhas de infraestrutura/transitórias (banco fora do ar, SQS inacessível) NÃO
 * devem estender esta classe — elas são retryable e tratadas em outro lugar. Um
 * `DomainError` é, por definição, determinístico: a mesma entrada sempre o produz.
 */
export abstract class DomainError extends Error {
  /** Identificador estável, legível por máquina. */
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restaura a cadeia de protótipos (necessário ao mirar ES2022 com transpiladores).
    Object.setPrototypeOf(this, new.target.prototype);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}
