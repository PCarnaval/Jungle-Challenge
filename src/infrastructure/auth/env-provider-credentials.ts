import type { ProviderCredentialsPort } from "../../application/ports/system.ports";

/**
 * Implementação de {@link ProviderCredentialsPort} apoiada em `PROVIDER_SECRETS`.
 * Em produção, trocar por um adaptador de secrets manager / tabela
 * `provider_credential`.
 */
export class EnvProviderCredentials implements ProviderCredentialsPort {
  constructor(private readonly secrets: Readonly<Record<string, string>>) {}

  async secretFor(providerId: string): Promise<string | null> {
    return this.secrets[providerId] ?? null;
  }
}
