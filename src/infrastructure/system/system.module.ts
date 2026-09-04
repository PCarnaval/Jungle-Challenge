import { Global, Module } from "@nestjs/common";

import { CLOCK, ID_GENERATOR } from "../../application/ports/tokens";
import { SystemClock } from "./system-clock";
import { Uuidv7IdGenerator } from "./uuidv7-id-generator";

/** Ports de sistema globais — um relógio real e um gerador de ids UUIDv7. */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: Uuidv7IdGenerator },
  ],
  exports: [CLOCK, ID_GENERATOR],
})
export class SystemModule {}
