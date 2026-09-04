import { Global, Module } from "@nestjs/common";
import { APP_CONFIG } from "../application/ports/tokens";
import { loadConfig } from "./app-config";

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
