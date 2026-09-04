import type { PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";
import { ValidationError } from "../../application/application-error";

/**
 * Valida uma parte da requisição contra um schema Zod. Só formato/presença — as
 * regras profundas de money/currency ficam no domínio (`Money.from`). Uma falha
 * vira um `ValidationError` → HTTP 400 via o exception filter.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const detail = result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new ValidationError(`Invalid request: ${detail}`);
    }
    return result.data;
  }
}
