import type { MessageKey } from "../../shared/i18n.ts";
import { useLocale } from "./LocaleContext";
import type { EngineExecutorView, EngineInstallationView } from "./types";

export function AgentList({
  agents,
  apps,
  busyId,
  onToggle,
}: {
  agents: EngineExecutorView[];
  apps: EngineInstallationView[];
  busyId: string | null;
  onToggle: (agent: EngineExecutorView) => void;
}) {
  const { t } = useLocale();
  if (agents.length === 0) {
    return <p className="muted">{t("agent.empty")}</p>;
  }
  return (
    <>
      {agents.map((agent) => {
        const disabled = agent.status === "disabled";
        const source = agentSource(agent, apps, t);
        return (
          <div className="executor-kind" key={agent.id}>
            <div className="app-row">
              <div className="app-row-copy">
                <strong>{agent.label}</strong>
                <p>
                  {[source, disabled ? t("agent.disabled") : null]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div className="app-row-actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={busyId === `ex:${agent.id}`}
                  onClick={() => onToggle(agent)}
                >
                  {disabled ? t("connector.enable") : t("connector.disable")}
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

function agentSource(
  agent: EngineExecutorView,
  apps: EngineInstallationView[],
  translate: (key: MessageKey, params?: Record<string, string>) => string,
): string | null {
  const app = agent.connector_id
    ? apps.find((item) => item.id === agent.connector_id)
    : undefined;
  if (app) {
    return translate("agent.from", { app: app.label });
  }
  if (agent.detail === "Auto · first creatable connector") {
    return translate("executor.detail.autoFirst");
  }
  if (agent.detail === "Connector missing") {
    return translate("executor.detail.connectorMissing");
  }
  return agent.detail;
}
