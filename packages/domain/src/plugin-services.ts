import type { IngestBatchProcessor } from "./connector-runner";
import type { ConnectorRegistry } from "./connector-registry";
import type { EgressRegistry } from "./egress";
import type { ExecutorRegistry } from "./executor";
import type { AuthorityStore, BlobStore, ConnectorRuntimeStore } from "./ingestion";
import type { WorkStore } from "./work";
import type { ExecutorStore } from "./executor-installation";

declare module "@regenic/plugin-host" {
  interface Services {
    authority: AuthorityStore & ConnectorRuntimeStore & WorkStore & ExecutorStore;
    blobs: BlobStore;
    ingest: IngestBatchProcessor;
    connectors: ConnectorRegistry;
    egress: EgressRegistry;
    executors: ExecutorRegistry;
  }
}
