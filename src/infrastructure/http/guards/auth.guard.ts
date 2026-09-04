import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";

import { APP_CONFIG, PROVIDER_CREDENTIALS } from "../../../application/ports/tokens";
import type { ProviderCredentialsPort } from "../../../application/ports/system.ports";
import type { AppConfig } from "../../../config/app-config";
import { MetricsService } from "../../observability/metrics.service";
import { verifyHmacSignature } from "../../auth/hmac";

interface SignedRequest {
  method: string;
  url: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
  body?: unknown;
}

/**
 * Guard de HMAC request signing (README item 2, ARCHITECTURE item 9).
 *
 * - `AUTH_MODE=none` (padrão): pass-through, então dev e as suites de teste
 *   anteriores à auth continuam funcionando sem mudança.
 * - `AUTH_MODE=hmac`: toda requisição protegida deve carregar `X-Provider-Id`,
 *   `X-Timestamp` e `X-Signature`; a assinatura é verificada contra o segredo
 *   compartilhado do provedor sobre `METHOD\nPATH\nPROVIDER_ID\nTS\nSHA256(body)`,
 *   o timestamp deve estar dentro de `HMAC_TIMESTAMP_TOLERANCE_SECONDS` e —
 *   quando o body carrega um `providerId` — ele deve ser igual ao autenticado.
 *
 * Aplicado aos controllers de wallets / wagering / providers, NÃO ao
 * `HealthController` / `MetricsController`. O caminho SQS é um canal interno
 * confiável e não é protegido.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PROVIDER_CREDENTIALS) private readonly credentials: ProviderCredentialsPort,
    private readonly metrics: MetricsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.config.auth.mode === "none") return true;

    const req = context.switchToHttp().getRequest<SignedRequest>();
    const header = (name: string): string | undefined => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };

    const providerId = header("x-provider-id");
    const timestamp = header("x-timestamp");
    const signature = header("x-signature");
    if (!providerId || !timestamp || !signature) {
      return this.deny("missing_headers", "missing X-Provider-Id / X-Timestamp / X-Signature");
    }

    const secret = await this.credentials.secretFor(providerId);
    if (!secret) {
      return this.deny("unknown_provider", `unknown provider "${providerId}"`);
    }

    const result = verifyHmacSignature({
      parts: {
        method: req.method,
        path: req.originalUrl ?? req.url,
        providerId,
        timestamp,
        rawBody: req.rawBody ?? Buffer.alloc(0),
      },
      signature,
      secret,
      now: new Date(),
      toleranceSeconds: this.config.auth.hmacTimestampToleranceSeconds,
    });
    if (!result.ok) {
      const reason = result.reason === "stale_timestamp" ? "stale_timestamp" : "bad_signature";
      return this.deny(reason, `signature rejected (${result.reason})`, providerId);
    }

    const bodyProviderId = (req.body as { providerId?: unknown } | undefined)?.providerId;
    if (typeof bodyProviderId === "string" && bodyProviderId !== providerId) {
      this.metrics.recordAuthFailure("provider_mismatch");
      this.logger.warn(`403 provider mismatch: body="${bodyProviderId}" auth="${providerId}"`);
      throw new ForbiddenException("body.providerId does not match the authenticated provider");
    }

    return true;
  }

  private deny(
    reason: Parameters<MetricsService["recordAuthFailure"]>[0],
    message: string,
    providerId?: string,
  ): never {
    this.metrics.recordAuthFailure(reason);
    this.logger.warn(`401 ${message}${providerId ? ` (provider=${providerId})` : ""}`);
    throw new UnauthorizedException(message);
  }
}
