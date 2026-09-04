import type { IntegrationEventEnvelope } from "../../domain/messaging/integration-event";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface MessagePublisher {
  publish(envelope: IntegrationEventEnvelope<unknown>): Promise<void>;
}


export interface ProviderCredentialsPort {
  secretFor(providerId: string): Promise<string | null>;
}
