import "@regenic/domain";
import type {
  AuthorityStore,
  ConnectorRuntimeStore,
  ContextArtifactStore,
  ContextAuthorityReader,
  ContextProjectionOutboxStore,
  DailyDigestJobStore,
  DailyDigestPolicyStore,
  DailyDigestCoverageAlertStore,
  ProposalStore,
  DecisionStore,
  ReviewStore,
  HandoffStore,
  StandardStore,
  StandardGapStore,
  ExecutorStore,
  WorkStore,
} from "@regenic/domain";
import type { HostContext } from "@regenic/plugin-host";

export type AuthorityServicesStore = AuthorityStore &
  ConnectorRuntimeStore &
  WorkStore &
  ExecutorStore &
  ContextArtifactStore &
  ContextAuthorityReader &
  ContextProjectionOutboxStore &
  DailyDigestJobStore & {
  } & DailyDigestPolicyStore & DailyDigestCoverageAlertStore & ProposalStore & DecisionStore & ReviewStore & HandoffStore & StandardStore & StandardGapStore & {
    close(): void | Promise<void>;
  };

export function provideAuthorityServices(
  ctx: HostContext,
  store: AuthorityServicesStore,
): void {
  ctx.provide("authority", store);
  ctx.provide("context-authority", store);
  ctx.provide("context-artifacts", store);
  ctx.provide("context-projection-outbox", store);
  ctx.provide("daily-digest-jobs", store);
  ctx.provide("daily-digest-policy", store);
  ctx.provide("daily-digest-coverage-alerts", store);
  ctx.provide("proposals", store);
  ctx.provide("decisions", store);
  ctx.provide("reviews", store);
  ctx.provide("handoffs", store);
  ctx.provide("standards", store);
  ctx.provide("standard-gaps", store);
  ctx.effect(() => () => store.close());
}
