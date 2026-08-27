import {
  type ArrangementDecision,
  type EventRecord,
} from "@regenic/domain";
import { PersonalKernelStoppedError } from "./personal-runtime.service";

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class WriteBackTimeoutError extends Error {
  constructor() {
    super("Write-back send timed out");
    this.name = "WriteBackTimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new WriteBackTimeoutError());
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function isWorkTickShutdown(error: unknown): boolean {
  if (error instanceof PersonalKernelStoppedError) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    (error instanceof TypeError && /database connection is not open/i.test(message)) ||
    /Service is not available/i.test(message)
  );
}

export async function forceDisposition(
  authority: {
    getDisposition(eventId: string): Promise<ArrangementDecision | null>;
    putDisposition(decision: ArrangementDecision): Promise<void>;
  },
  event: EventRecord,
  disposition: ArrangementDecision["disposition"],
  reason: string,
  now: string,
): Promise<void> {
  const current = await authority.getDisposition(event.id);
  await authority.putDisposition({
    event_id: event.id,
    org_id: event.org_id,
    disposition,
    layer: current?.layer ?? "L1_event",
    reason_codes: [...new Set([...(current?.reason_codes ?? []), reason])],
    score: current?.score ?? 0.7,
    decided_at: now,
  });
}
