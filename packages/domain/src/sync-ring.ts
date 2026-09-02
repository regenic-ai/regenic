import type { SyncCatalogMember, SyncStreamState } from "./sync-contracts";
import { isSteadyPhase } from "./sync-lifecycle";
import { syncStateIsDue } from "./sync-phase";

/** Rotates through steady streams and selects the next due live polls. */
export class SyncLiveRing {
  private ringCursor = 0;
  private readonly forceDue = new Set<string>();

  /** Treat a stream as due on the next steady tick (e.g. after webhook ingest). */
  nudge(streamKey: string): void {
    const key = streamKey.trim();
    if (key) {
      this.forceDue.add(key);
    }
  }

  nudgeThread(
    threadId: string,
    members: readonly SyncCatalogMember[],
  ): void {
    const id = threadId.trim();
    if (!id) {
      return;
    }
    for (const member of members) {
      if (member.thread_id === id) {
        this.nudge(member.stream_key);
      }
    }
  }

  nextDue(
    members: readonly SyncCatalogMember[],
    states: ReadonlyMap<string, SyncStreamState>,
    now: string,
    limit: number,
    excluded: ReadonlySet<string> = new Set(),
  ): SyncCatalogMember[] {
    const steady = members.filter((member) => {
      if (excluded.has(member.stream_key)) {
        return false;
      }
      return isSteadyPhase(states.get(member.stream_key)?.phase);
    });
    if (steady.length === 0 || limit <= 0) {
      return [];
    }

    const eligible = steady.filter((member) => {
      const state = states.get(member.stream_key);
      return (
        this.forceDue.has(member.stream_key) || syncStateIsDue(state, now, false)
      );
    });
    if (eligible.length === 0) {
      return [];
    }

    const urgency = (member: SyncCatalogMember): [number, number, string] => {
      if (this.forceDue.has(member.stream_key)) {
        return [0, 0, member.stream_key];
      }
      const idleUntil = states.get(member.stream_key)?.idle_until;
      const overdueMs =
        idleUntil && Number.isFinite(Date.parse(idleUntil))
          ? Date.parse(now) - Date.parse(idleUntil)
          : 0;
      return [1, -Math.max(0, overdueMs), member.stream_key];
    };
    const ranked = [...eligible].sort((left, right) => {
      const [leftTier, leftOverdue, leftKey] = urgency(left);
      const [rightTier, rightOverdue, rightKey] = urgency(right);
      if (leftTier !== rightTier) {
        return leftTier - rightTier;
      }
      if (leftOverdue !== rightOverdue) {
        return leftOverdue - rightOverdue;
      }
      return leftKey.localeCompare(rightKey);
    });

    const start =
      this.ringCursor >= ranked.length ? 0 : this.ringCursor % ranked.length;
    const rotated = [...ranked.slice(start), ...ranked.slice(0, start)];
    const picked = rotated.slice(0, limit);
    if (picked.length > 0) {
      const last = picked[picked.length - 1];
      const index = ranked.findIndex(
        (member) => member.stream_key === last.stream_key,
      );
      this.ringCursor = index >= 0 ? (index + 1) % ranked.length : 0;
      for (const member of picked) {
        this.forceDue.delete(member.stream_key);
      }
    }
    return picked;
  }

  adoptRotateFrom(rotateFrom: string | undefined, members: readonly SyncCatalogMember[]): void {
    if (!rotateFrom) {
      return;
    }
    const steady = members.filter((member) => member.stream_key);
    const index = steady.findIndex((member) => member.stream_key === rotateFrom);
    if (index >= 0) {
      this.ringCursor = (index + 1) % steady.length;
    }
  }
}
