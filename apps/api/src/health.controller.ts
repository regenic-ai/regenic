import { Controller, Get } from "@nestjs/common";
import { Client } from "pg";
import { loadEnv } from "@regenic/config";
import type { StandardPlaceholder } from "@regenic/domain";

@Controller()
export class HealthController {
  @Get("health")
  async health() {
    const env = loadEnv();
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

    // Workspace link probe only — not a product resource.
    const _domainProbe: StandardPlaceholder | null = null;
    void _domainProbe;

    return {
      status: postgres === "up" ? "ok" : "degraded",
      service: "api",
      postgres,
      domain: "@regenic/domain",
    };
  }
}
