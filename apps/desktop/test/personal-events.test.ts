import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  connectPersonalEventsWithDeps,
  personalEventsUrl,
} from "../src/renderer/src/personal-events-core.ts";

type Listener = (event: MessageEvent) => void;

class MockEventSource {
  static readonly instances: MockEventSource[] = [];

  readonly url: string;
  readonly listeners = new Map<string, Listener>();
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, payload: unknown): void {
    const listener = this.listeners.get(type);
    listener?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

describe("personalEventsUrl", () => {
  it("builds the SSE endpoint from the kernel origin", () => {
    assert.equal(
      personalEventsUrl("http://127.0.0.1:4370"),
      "http://127.0.0.1:4370/v1/me/events",
    );
  });
});

describe("connectPersonalEventsWithDeps", () => {
  it("opens the SSE stream and forwards inbox.digest", () => {
    MockEventSource.instances.length = 0;
    const digests: string[] = [];
    const disconnect = connectPersonalEventsWithDeps(
      {
        onInboxDigest: (digest) => {
          digests.push(digest);
        },
      },
      {
        origin: () => "http://127.0.0.1:4370",
        subscribeOrigin: () => () => undefined,
        EventSource: MockEventSource as unknown as typeof EventSource,
        setTimeout: () => 0,
        clearTimeout: () => undefined,
      },
    );
    assert.equal(MockEventSource.instances.length, 1);
    assert.equal(
      MockEventSource.instances[0]?.url,
      "http://127.0.0.1:4370/v1/me/events",
    );
    MockEventSource.instances[0]?.emit("inbox.digest", { digest: "1:abc" });
    assert.deepEqual(digests, ["1:abc"]);
    disconnect();
    assert.equal(MockEventSource.instances[0]?.closed, true);
  });

  it("reconnects when the kernel origin changes", () => {
    MockEventSource.instances.length = 0;
    let origin = "http://127.0.0.1:4370";
    let notifyOrigin = () => undefined;
    const disconnect = connectPersonalEventsWithDeps(
      {},
      {
        origin: () => origin,
        subscribeOrigin: (listener) => {
          notifyOrigin = listener;
          return () => undefined;
        },
        EventSource: MockEventSource as unknown as typeof EventSource,
        setTimeout: () => 0,
        clearTimeout: () => undefined,
      },
    );
    assert.equal(MockEventSource.instances[0]?.url, personalEventsUrl(origin));
    origin = "http://127.0.0.1:4371";
    notifyOrigin();
    assert.equal(MockEventSource.instances.length, 2);
    assert.equal(MockEventSource.instances[0]?.closed, true);
    assert.equal(
      MockEventSource.instances[1]?.url,
      "http://127.0.0.1:4371/v1/me/events",
    );
    disconnect();
    assert.equal(MockEventSource.instances[1]?.closed, true);
  });
});
