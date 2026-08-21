import type { IngestBatchProcessor } from "./connector-runner";
import type { ConnectorRegistry } from "./connector-registry";
import type { EgressRegistry } from "./egress";
import type { AuthorityStore, BlobStore, ConnectorRuntimeStore } from "./ingestion";

declare module "@regenic/plugin-host" {
  interface Services {
    authority: AuthorityStore & ConnectorRuntimeStore;
    blobs: BlobStore;
    ingest: IngestBatchProcessor;
    connectors: ConnectorRegistry;
    egress: EgressRegistry;
  }
}
