import {
  ModelUnavailableError,
  type ModelCompletionRequest,
  type ModelProvider,
} from "@regenic/domain";

export class NoneModelProvider implements ModelProvider {
  constructor(
    private readonly message = "Model provider is not configured",
  ) {}

  async complete(_request: ModelCompletionRequest): Promise<never> {
    throw new ModelUnavailableError(this.message);
  }

  async health() {
    return { status: "degraded" as const, driver: "none" };
  }
}
