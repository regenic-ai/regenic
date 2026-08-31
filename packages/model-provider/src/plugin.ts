import { definePlugin } from "@regenic/plugin-host";
import { parseCredentialsRef } from "@regenic/domain";
import { NoneModelProvider } from "./none";
import {
  OpenAICompatibleModelProvider,
  type OpenAICompatibleModelProviderOptions,
} from "./openai-compatible";

export type ModelProviderPluginConfig =
  | { driver: "none"; message?: string }
  | ({ driver: "openai_compatible" } & OpenAICompatibleModelProviderOptions);

export function modelProviderConfigFromEnv(
  env: NodeJS.ProcessEnv,
): ModelProviderPluginConfig {
  const driver = env.REGENIC_MODEL_DRIVER?.trim() || "none";
  if (driver === "none") {
    return { driver: "none" };
  }
  if (driver !== "openai_compatible") {
    return {
      driver: "none",
      message: "Model provider configuration is invalid",
    };
  }
  try {
    const apiKeyRef = env.REGENIC_MODEL_API_KEY_REF;
    const parsedRef = parseCredentialsRef(apiKeyRef);
    const credentialEnv: NodeJS.ProcessEnv = {};
    if (parsedRef?.kind === "env" && env[parsedRef.name] !== undefined) {
      credentialEnv[parsedRef.name] = env[parsedRef.name];
    }
    return {
      driver,
      base_url: env.REGENIC_MODEL_BASE_URL ?? "",
      model: env.REGENIC_MODEL_NAME ?? "",
      api_key_ref: apiKeyRef,
      timeout_ms: envInteger(env.REGENIC_MODEL_TIMEOUT_MS, 30_000),
      max_response_bytes: envInteger(
        env.REGENIC_MODEL_MAX_RESPONSE_BYTES,
        1_048_576,
      ),
      env: credentialEnv,
    };
  } catch {
    return {
      driver: "none",
      message: "Model provider configuration is invalid",
    };
  }
}

export const modelProviderPlugin = definePlugin<ModelProviderPluginConfig>({
  name: "model-provider",
  apply(ctx, config) {
    let provider;
    try {
      provider = config.driver === "none"
        ? new NoneModelProvider(config.message)
        : new OpenAICompatibleModelProvider(config);
    } catch {
      provider = new NoneModelProvider("Model provider configuration is invalid");
    }
    ctx.provide("model", provider);
  },
});

function envInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || !value.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Model numeric environment setting must be an integer");
  }
  return parsed;
}
