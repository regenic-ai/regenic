import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ChannelDriver } from "@regenic/domain";

const nodeRequire = createRequire(__filename);

/**
 * Private CRM drivers. The public tree does not depend on the package.
 * A machine without `@bioby/regenic-crm-connector` simply gets no CRM driver,
 * so the Engine catalog row stays blocked.
 */
export function optionalCrmDrivers(): ChannelDriver[] {
  const spec = resolveCrmConnectorModule();
  if (!spec) {
    return [];
  }
  try {
    const loaded = nodeRequire(spec) as {
      crmOpsReviewDriver?: ChannelDriver;
      crmOrderReviewDriver?: ChannelDriver;
    };
    return [loaded.crmOpsReviewDriver, loaded.crmOrderReviewDriver].filter(
      (driver): driver is ChannelDriver =>
        Boolean(driver?.connector_type && driver.source),
    );
  } catch {
    return [];
  }
}

function resolveCrmConnectorModule(): string | undefined {
  const candidates = [
    process.env.REGENIC_CRM_CONNECTOR?.trim(),
    "@bioby/regenic-crm-connector",
    path.resolve(__dirname, "../../../../bioby-plugins/regenic-crm-connector"),
  ].filter((item): item is string => Boolean(item));
  for (const spec of candidates) {
    try {
      return nodeRequire.resolve(spec);
    } catch {
      if (existsSync(path.join(spec, "package.json"))) {
        return spec;
      }
    }
  }
  return undefined;
}
