import {
  canonicalContextJson,
  hashCanonicalContext,
  type ActorRef,
  type ContextPolicyEvaluator,
  type ContextRequest,
} from "@regenic/domain";

export interface PersonalContextPolicyOptions {
  org_id: string;
  principal: ActorRef;
}

export class PersonalContextPolicyEvaluator implements ContextPolicyEvaluator {
  private readonly orgId: string;
  private readonly principal: ActorRef;

  constructor(options: PersonalContextPolicyOptions) {
    if (!options.org_id.trim() || !options.principal.actor_id.trim()) {
      throw new Error("Personal context policy requires an organization and principal");
    }
    this.orgId = options.org_id;
    this.principal = structuredClone(options.principal);
  }

  async policyHash(request: ContextRequest): Promise<string> {
    this.assertPrincipal(request);
    return hashCanonicalContext({
      version: "personal-context-policy-v1",
      org_id: this.orgId,
      principal: this.principal,
      purpose: request.purpose,
      allowed_uses: [...request.allowed_uses].sort(compare),
    });
  }

  async visible({ request, resource }: Parameters<ContextPolicyEvaluator["visible"]>[0]) {
    return this.matchesPrincipal(request) &&
      resource.required_scope_ids.length > 0 &&
      resource.required_scope_ids.every((scope) => scope.trim().length > 0);
  }

  async protectedEventIds(
    input: Parameters<ContextPolicyEvaluator["protectedEventIds"]>[0],
  ): Promise<string[]> {
    this.assertPrincipal(input.request);
    return [];
  }

  async canReplay({ request }: Parameters<ContextPolicyEvaluator["canReplay"]>[0]) {
    return this.matchesPrincipal(request);
  }

  private assertPrincipal(request: Pick<ContextRequest, "org_id" | "principal">): void {
    if (!this.matchesPrincipal(request)) {
      throw new Error("Context request is outside the personal authority boundary");
    }
  }

  private matchesPrincipal(
    request: Pick<ContextRequest, "org_id" | "principal">,
  ): boolean {
    return request.org_id === this.orgId &&
      canonicalContextJson(request.principal) === canonicalContextJson(this.principal);
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
