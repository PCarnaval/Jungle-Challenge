/**
 * Tokens de DI das ports de aplicação. A infraestrutura liga os adaptadores
 * concretos a estes; os use cases dependem apenas da interface + token.
 */
export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");
export const CLOCK = Symbol("CLOCK");
export const ID_GENERATOR = Symbol("ID_GENERATOR");
export const APP_CONFIG = Symbol("APP_CONFIG");
export const MESSAGE_PUBLISHER = Symbol("MESSAGE_PUBLISHER");
export const PROVIDER_CREDENTIALS = Symbol("PROVIDER_CREDENTIALS");
export const METRICS = Symbol("METRICS");
export const SQS_CLIENT = Symbol("SQS_CLIENT");

/** Os repositórios normalmente vêm do UnitOfWork, mas ficam expostos para os caminhos de leitura. */
export const WALLET_REPOSITORY = Symbol("WALLET_REPOSITORY");
export const WAGER_TRANSACTION_REPOSITORY = Symbol("WAGER_TRANSACTION_REPOSITORY");
export const LEDGER_REPOSITORY = Symbol("LEDGER_REPOSITORY");
export const OUTBOX_REPOSITORY = Symbol("OUTBOX_REPOSITORY");
export const INBOX_REPOSITORY = Symbol("INBOX_REPOSITORY");
