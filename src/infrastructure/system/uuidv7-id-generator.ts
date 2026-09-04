import { Injectable } from "@nestjs/common";
import { uuidv7 } from "uuidv7";
import type { IdGenerator } from "../../application/ports/system.ports";

/** UUIDv7 — ordenado por tempo, então os ids ordenam aproximadamente por criação e indexam bem. */
@Injectable()
export class Uuidv7IdGenerator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}
