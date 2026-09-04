import { Module } from "@nestjs/common";

import { ApplicationModule } from "../../application/application.module";
import { MessagingModule } from "../messaging/messaging.module";
import { ReadinessService } from "../health/readiness.service";
import { APP_CONFIG, PROVIDER_CREDENTIALS } from "../../application/ports/tokens";
import type { AppConfig } from "../../config/app-config";
import { EnvProviderCredentials } from "../auth/env-provider-credentials";

import { AuthGuard } from "./guards/auth.guard";
import { HealthController } from "./controllers/health.controller";
import { ProvidersController } from "./controllers/providers.controller";
import { WageringController } from "./controllers/wagering.controller";
import { WalletsController } from "./controllers/wallets.controller";

@Module({
  imports: [ApplicationModule, MessagingModule],
  controllers: [
    WalletsController,
    WageringController,
    ProvidersController,
    HealthController,
  ],
  providers: [
    {
      provide: PROVIDER_CREDENTIALS,
      useFactory: (config: AppConfig) => new EnvProviderCredentials(config.auth.providerSecrets),
      inject: [APP_CONFIG],
    },
    AuthGuard,
    ReadinessService,
  ],
})
export class HttpApiModule {}
