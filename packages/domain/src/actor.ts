/** @unstable RFC 0001 */
export type ActorType = "human" | "agent" | "system";

/** @unstable RFC 0001 / 0004 */
export interface ActorRef {
  actor_type: ActorType;
  actor_id: string;
}