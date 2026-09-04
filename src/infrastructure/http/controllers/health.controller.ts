import { Controller, Get, Res } from "@nestjs/common";
import { ReadinessService } from "../../health/readiness.service";
import type { ResponseLike } from "../http.types";

/** Sem autenticação — README item 9. */
@Controller("health")
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) res: ResponseLike): Promise<unknown> {
    const result = await this.readiness.check();
    res.status(result.ready ? 200 : 503);
    return {
      status: result.ready ? "ok" : "unavailable",
      checks: result.checks,
    };
  }
}
