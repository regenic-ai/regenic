import { Controller, Get, Inject } from "@nestjs/common";
import { Client } from "pg";
import { isPersonalApiEnabled, loadEnv } from "@regenic/config";
import type { StandardPlaceholder } from "@regenic/domain";
import { processMemoryView } from "./process-memory";
import { PersonalApiKeyService } from "./personal-api-key.service";
import { PersonalPairingService } from "./personal-pairing.service";
import { KernelRuntimeService } from "./kernel-runtime.service";
import { PersonalRuntimeService } from "./personal-runtime.service";

@Controller()
export class HealthController {
  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
    @Inject(PersonalApiKeyService)
    private readonly keys: PersonalApiKeyService,
    @Inject(PersonalPairingService)
    private readonly pairing: PersonalPairingService,
    @Inject(KernelRuntimeService)
    private readonly kernelRuntime: KernelRuntimeService,
  ) {}

  @Get("health")
  async health() {
    const env = loadEnv();
    const _domainProbe: StandardPlaceholder | null = null;
    void _domainProbe;

    if (env.REGENIC_DATABASE) {
      const sqlite = this.runtime.isReady() ? "up" : "down";
      const personal = isPersonalApiEnabled(env);
      const expectedKey = this.keys.expectedKey();
      const pressure = this.kernelRuntime.pressureView();
      return {
        status: sqlite === "up" && pressure.interactive_ready ? "ok" : "degraded",
        service: "api",
        mode: personal ? "personal" : "service",
        sqlite,
        memory: processMemoryView(),
        runtime: pressure,
        domain: "@regenic/domain",
        ...(personal
          ? {
              connect: {
                auth: expectedKey ? "shared-secret" : "none",
                key_source: this.keys.keySource(),
                pairing: {
                  ...this.pairing.snapshot(process.env),
                  reason: this.keys.pairingState(process.env).reason,
                },
              },
            }
          : {}),
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
