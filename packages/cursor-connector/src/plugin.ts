import "@regenic/domain";
import { definePlugin } from "@regenic/plugin-host";
import type { CursorAgentSummary, CursorConversation } from "./cursor-api-client";
import { CursorAgentEgress } from "./cursor-agent-egress";
import { CursorAgentPollConnector } from "./cursor-agent-poll-connector";
import { cursorLocalClient, type CursorLocalClient } from "./cursor-local-client";

export interface CursorAgentPluginAgent {
  id: string;
  name?: string;
}

export interface CursorAgentPluginConfig {
  installation_id: string;
  org_id: string;
  api_key: string;
  model?: string;
  cwd?: string;
  agents: CursorAgentPluginAgent[];
  local?: CursorLocalClient;
  now?: () => string;
}

export function cursorStreamKey(agentId: string): string {
  return `agent:${agentId}`;
}

export const cursorAgentPlugin = definePlugin<CursorAgentPluginConfig>({
  name: "cursor-agent",
  inject: ["connectors", "egress"],
  apply(ctx, config) {
    const client = historyClient(config);
    ctx.effect(() => {
      const disposers = config.agents.flatMap((agent) => {
        const connector = new CursorAgentPollConnector(client, {
          connector_id: config.installation_id,
          org_id: config.org_id,
          agent_id: agent.id,
          agent_name: agent.name,
          now: config.now,
        });
        const egress = new CursorAgentEgress(client, {
          installation_id: config.installation_id,
          agent_id: agent.id,
        });
        return [
          ctx.get("connectors").register(config.installation_id, connector, {
            stream_key: cursorStreamKey(agent.id),
            thread_id: `cursor:${agent.id}`,
            label: agent.name ?? agent.id,
          }),
          ctx.get("egress").register(
            config.installation_id,
            egress,
            cursorStreamKey(agent.id),
          ),
        ];
      });
      return () => {
        for (const dispose of disposers.reverse()) {
          dispose();
        }
      };
    });
  },
});

function historyClient(config: CursorAgentPluginConfig): {
  getAgent(agentId: string): Promise<CursorAgentSummary>;
  getConversation(agentId: string): Promise<CursorConversation>;
  createRun(agentId: string, text: string): Promise<{ id: string }>;
  flushPending(agentId: string): Promise<void>;
} {
  const local = config.local ?? cursorLocalClient();
  const cwd = config.cwd ?? process.cwd();
  return {
    getAgent: (agentId) =>
      local.getAgent({ apiKey: config.api_key, agentId, cwd }),
    getConversation: (agentId) =>
      local.getConversation({ apiKey: config.api_key, agentId, cwd }),
    createRun: (agentId, text) =>
      local.send({
        apiKey: config.api_key,
        agentId,
        text,
        cwd,
        model: config.model,
      }),
    flushPending: (agentId) =>
      local.flushPending?.({ apiKey: config.api_key, agentId, cwd })
      ?? Promise.resolve(),
  };
}
