import { Global, Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { MikroORM } from "@mikro-orm/core";

import { UNIT_OF_WORK } from "../../application/ports/tokens";
import { MetricsService } from "../observability/metrics.service";
import mikroOrmConfig from "./mikro-orm/mikro-orm.config";
import { MikroUnitOfWork } from "./mikro-orm/mikro-unit-of-work";

/**
 * Liga o MikroORM e o boundary transacional. Global, para que `UNIT_OF_WORK` (e,
 * via `MikroOrmModule.forRoot`, `MikroORM` / `EntityManager`) sejam injetáveis
 * em qualquer lugar sem re-exportar.
 */
@Global()
@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  providers: [
    {
      provide: UNIT_OF_WORK,
      useFactory: (orm: MikroORM, metrics: MetricsService) =>
        new MikroUnitOfWork(orm, () => metrics.recordLockConflict()),
      inject: [MikroORM, MetricsService],
    },
  ],
  exports: [UNIT_OF_WORK],
})
export class PersistenceModule {}
