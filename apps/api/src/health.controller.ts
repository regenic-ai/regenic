import { Controller, Get } from "@nestjs/common";
import { Client } from "pg";
import { isPersonalApiEnabled, loadEnv } from "@regenic/config";
import type { StandardPlaceholder } from "@regenic/domain";
import { processMemoryView } from "./process-memory";
import { PersonalRuntimeService } from "./personal-runtime.service";

async function probeDsh(baseUrl: string | undefined): Promise<"up" | "down" | undefined> {
  const url = baseUrl?.trim();
  if (!url) {
    return undefined;
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok ? "up" : "down";
  } catch {
    return "down";
  }
}

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
      const dsh = await probeDsh(env.REGENIC_DSH_BASE_URL);
      const status = sqlite === "up" && dsh !== "down" ? "ok" : "degraded";
      return {
        status,
        service: "api",
        mode: isPersonalApiEnabled(env) ? "personal" : "service",
        sqlite,
        ...(dsh ? { dsh } : {}),
        memory: processMemoryView(),
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
      memory: processMemoryView(),
      domain: "@regenic/domain",
    };
  }
}
