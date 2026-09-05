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
  ContextProjectionRunner,
  ContextProjectorRegistry,
  ContextRetrieverRegistry,
} from "./context-port";
import type { ModelProvider } from "./model-provider";
import type { ContextProjectionOutboxStore } from "./context-projection-outbox";
import type { ContextLexicalIndex } from "./context-lexical";

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
    "context-projections": ContextProjectionRunner;
    "context-projection-outbox": ContextProjectionOutboxStore;
    "context-lexical-index": ContextLexicalIndex;
    "context-projectors": ContextProjectorRegistry;
    "context-retrievers": ContextRetrieverRegistry;
    model: ModelProvider;
  }
}
