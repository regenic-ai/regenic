import type { IngestBatchProcessor } from "./connector-runner";
import type { ConnectorRegistry } from "./connector-registry";
import type { EgressRegistry } from "./egress";
import type { ExecutorRegistry } from "./executor";
import type { AuthorityStore, BlobStore, ConnectorRuntimeStore } from "./ingestion";
import type { WorkStore } from "./work";
import type { ExecutorStore } from "./executor-installation";
import type {
  ContextAuthorityReader,
  ContextArtifactStore,
  ContextEngine,
  ContextProjectorRegistry,
  ContextRetrieverRegistry,
} from "./context-port";

declare module "@regenic/plugin-host" {
  interface Services {
    authority: AuthorityStore & ConnectorRuntimeStore & WorkStore & ExecutorStore;
    blobs: BlobStore;
    ingest: IngestBatchProcessor;
    connectors: ConnectorRegistry;
    egress: EgressRegistry;
    executors: ExecutorRegistry;
    context: ContextEngine;
    "context-authority": ContextAuthorityReader;
    "context-artifacts": ContextArtifactStore;
    "context-projectors": ContextProjectorRegistry;
    "context-retrievers": ContextRetrieverRegistry;
  }
}
