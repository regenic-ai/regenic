import { Controller, Get, Inject } from "@nestjs/common";
import { isPersonalApiEnabled, loadEnv, resolveAuthorityBackend } from "@regenic/config";
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

    const backend = resolveAuthorityBackend(env);
    const personal = isPersonalApiEnabled(env);
    const expectedKey = this.keys.expectedKey();
    const pressure = this.kernelRuntime.pressureView();
    const ready = this.runtime.isReady();
    const connect = personal
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
      : {};

    if (backend.driver === "sqlite") {
      const sqlite = ready ? "up" : "down";
      return {
        status: sqlite === "up" && pressure.interactive_ready ? "ok" : "degraded",
        service: "api",
        mode: personal ? "personal" : "service",
        sqlite,
        authority: "authority-sqlite",
        memory: processMemoryView(),
        runtime: pressure,
        domain: "@regenic/domain",
        ...connect,
      };
    }

    if (backend.driver === "postgres") {
      const postgres =
        ready && (await this.runtime.probeAuthority()) ? "up" : "down";
      return {
        status: postgres === "up" && pressure.interactive_ready ? "ok" : "degraded",
        service: "api",
        mode: personal ? "personal" : "service",
        postgres,
        authority: "authority-postgres",
        memory: processMemoryView(),
        runtime: pressure,
        domain: "@regenic/domain",
        ...connect,
      };
    }

    return {
      status: "degraded",
      service: "api",
      mode: personal ? "personal" : "service",
      memory: processMemoryView(),
      domain: "@regenic/domain",
    };
  }
}
