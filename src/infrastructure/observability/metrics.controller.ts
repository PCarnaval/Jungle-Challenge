import { Controller, Get, Header } from "@nestjs/common";
import { MetricsService } from "./metrics.service";

/** Endpoint de scrape do Prometheus. Sem autenticação, como `/health`. */
@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  @Header("Cache-Control", "no-store")
  scrape(): Promise<string> {
    return this.metrics.render();
  }
}
