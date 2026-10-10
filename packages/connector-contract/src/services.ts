import type { EgressRegistry } from "./egress";
import type { ConnectorRegistry } from "./driver";

declare module "@regenic/plugin-host" {
  interface Services {
    connectors: ConnectorRegistry;
    egress: EgressRegistry;
  }
}
