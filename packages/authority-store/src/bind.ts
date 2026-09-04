import "@regenic/domain";
import type {
  AuthorityStore,
  ConnectorRuntimeStore,
  ContextArtifactStore,
  ContextAuthorityReader,
  ContextProjectionOutboxStore,
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
  ContextProjectionOutboxStore & {
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
  ctx.effect(() => () => store.close());
}
