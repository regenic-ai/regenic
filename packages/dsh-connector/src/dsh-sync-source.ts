import type { SyncDirectoryPage, SyncSource } from "@regenic/domain";
import type { DshWebRpcClient } from "./dsh-rpc-client";
import { dshStreamKey } from "./plugin";

const DSH_SOURCE = "dsh";

export function createDshSessionSyncSource(sessionId: string): SyncSource {
  return {
    async listDirectory(): Promise<SyncDirectoryPage> {
      return {
        members: [
          {
            stream_key: dshStreamKey(sessionId),
            thread_id: `${DSH_SOURCE}:${sessionId}`,
          },
        ],
        complete: true,
      };
    },
  };
}

export function createDshWebSyncSource(
  client: Pick<DshWebRpcClient, "sessionList">,
): SyncSource {
  return {
    async listDirectory(cursor: string | null): Promise<SyncDirectoryPage> {
      const page = await client.sessionList(cursor ? { cursor } : {});
      return {
        members: page.session_ids.map((sessionId) => ({
          stream_key: dshStreamKey(sessionId),
          thread_id: `${DSH_SOURCE}:${sessionId}`,
        })),
        next_cursor: page.next_cursor,
        complete: page.has_more !== true || !page.next_cursor,
      };
    },
  };
}
