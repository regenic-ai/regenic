import { Injectable } from "@nestjs/common";
import { loadEnv } from "@regenic/config";
import {
  createDshHostRpcServices,
  handleDshPublicRpc,
  type DshRpcHttpResult,
} from "@regenic/dsh-connector";
import { PersonalRuntimeService } from "./personal-runtime.service";

export interface DshApiRequest {
  contentType: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

@Injectable()
export class DshApiService {
  constructor(private readonly runtime: PersonalRuntimeService) {}

  async handle(method: string, input: DshApiRequest): Promise<DshRpcHttpResult> {
    const env = loadEnv();
    if (env.REGENIC_DSH_API_TOKEN) {
      const expected = `Bearer ${env.REGENIC_DSH_API_TOKEN}`;
      if (input.authorization !== expected) {
        return {
          status: 401,
          body: {
            error: { code: "unauthorized", message: "Bearer token required" },
          },
        };
      }
    }
    const host = this.runtime.getHost();
    if (!host) {
      return {
        status: 503,
        body: {
          error: {
            code: "not_configured",
            message: "REGENIC_DATABASE and REGENIC_BLOB_ROOT are required",
          },
        },
      };
    }
    return handleDshPublicRpc(
      method,
      { contentType: input.contentType, body: input.body },
      createDshHostRpcServices(host, {
        org_id: env.REGENIC_ORG,
        access_token: env.REGENIC_DSH_TOKEN,
      }),
    );
  }
}
