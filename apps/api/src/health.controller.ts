import { Controller, Get } from "@nestjs/common";
import { Client } from "pg";
import { loadEnv } from "@regenic/config";
import type { StandardPlaceholder } from "@regenic/domain";
import { PersonalRuntimeService } from "./personal-runtime.service";

@Controller()
export class HealthController {
  constructor(private readonly runtime: PersonalRuntimeService) {}

  @Get("health")
  async health() {
    const env = loadEnv();
    const _domainProbe: StandardPlaceholder | null = null;
    void _domainProbe;

    if (env.REGENIC_DATABASE) {
      const sqlite = this.runtime.isReady() ? "up" : "down";
      return {
        status: sqlite === "up" ? "ok" : "degraded",
        service: "api",
        mode: "personal",
        sqlite,
        domain: "@regenic/domain",
      };
    }

    let postgres: "up" | "down" = "down";
    const client = new Client({ connectionString: env.DATABASE_URL });
    try {
      await client.connect();
      await client.query("select 1");
      postgres = "up";
    } catch {
      postgres = "down";
    } finally {
      await client.end().catch(() => undefined);
    }

    return {
      status: postgres === "up" ? "ok" : "degraded",
      service: "api",
      mode: "service",
      postgres,
      domain: "@regenic/domain",
    };
  }
}
