import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";

import { ApplicationError } from "../../../application/application-error";
import type { ResponseLike } from "../http.types";
import { DomainError } from "../../../domain/shared/domain-error";
import { FailureCode } from "../../../domain/wagering/failure-code";
import {
  TransientInfrastructureError,
  UniqueConstraintError,
} from "../../../application/ports/unit-of-work.port";

interface ErrorBody {
  failureCode: string;
  message: string;
}

/**
 * O único lugar onde a API transforma um erro lançado em código de status +
 * corpo legível por máquina. *Rejeições* de negócio não são erros — voltam como
 * um resultado normal com `status: "REJECTED"` e são mapeadas para 422 pelo
 * controller.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("HttpException");

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<ResponseLike>();
    const { status, body } = this.map(exception);
    if (status >= 500) {
      this.logger.error(
        `${status} ${body.failureCode}: ${(exception as Error)?.stack ?? String(exception)}`,
      );
    }
    res.status(status).json(body);
  }

  private map(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof ApplicationError) {
      const status =
        exception.kind === "validation"
          ? 400
          : exception.kind === "not_found"
            ? 404
            : exception.kind === "conflict"
              ? 409
              : 503;
      return { status, body: { failureCode: exception.failureCode, message: exception.message } };
    }

    if (exception instanceof TransientInfrastructureError) {
      return {
        status: 503,
        body: { failureCode: FailureCode.InternalError, message: "Temporary failure, retry later" },
      };
    }

    if (exception instanceof UniqueConstraintError) {
      return {
        status: 409,
        body: { failureCode: FailureCode.ValidationError, message: `Conflict: ${exception.constraint}` },
      };
    }

    if (exception instanceof DomainError) {
      // Uma regra de domínio que vazou por um use case — trata como unprocessable.
      return { status: 422, body: { failureCode: exception.code, message: exception.message } };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === "string"
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message);
      const failureCode =
        status === 401
          ? FailureCode.Unauthenticated
          : status === 403
            ? FailureCode.Forbidden
            : FailureCode.ValidationError;
      return {
        status,
        body: {
          failureCode,
          message: Array.isArray(message) ? message.join("; ") : String(message),
        },
      };
    }

    return {
      status: 500,
      body: { failureCode: FailureCode.InternalError, message: "Internal server error" },
    };
  }
}
