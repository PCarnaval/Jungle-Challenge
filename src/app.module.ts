import { Module } from "@nestjs/common";

import { ConfigModule } from "./config/config.module";
import { ObservabilityModule } from "./infrastructure/observability/observability.module";
import { SystemModule } from "./infrastructure/system/system.module";
import { PersistenceModule } from "./infrastructure/persistence/persistence.module";
import { ApplicationModule } from "./application/application.module";
import { HttpApiModule } from "./infrastructure/http/http-api.module";
import { MessagingModule } from "./infrastructure/messaging/messaging.module";
import { WorkersModule } from "./infrastructure/workers/workers.module";

/**
 * O sistema inteiro num único grafo. Todo processo expõe a API HTTP (health é
 * útil em qualquer lugar); o consumidor SQS, o relay do outbox e o worker de
 * referências pendentes se auto-habilitam pela env `WORKER`, então uma réplica
 * `WORKER=consumer` roda só o loop do consumidor.
 */
@Module({
  imports: [
    ConfigModule,
    ObservabilityModule,
    SystemModule,
    PersistenceModule,
    ApplicationModule,
    HttpApiModule,
    MessagingModule,
    WorkersModule,
  ],
})
export class AppModule {}
