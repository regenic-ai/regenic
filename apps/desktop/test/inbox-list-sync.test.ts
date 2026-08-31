import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideInboxSync,
  inboxHeadsFact,
  inboxHeadsRequest,
  INBOX_FULL_REFRESH_MS,
  nextInboxSyncClocks,
  type InboxHeadsPageView,
  type InboxSyncClocks,
} from "../src/renderer/src/inbox-list-sync.ts";

const FRESH = "1:2026-08-23T00:00:00.000Z:e1:0:";
const NEWER = "1:2026-08-23T00:00:01.000Z:e2:0:";
const SURFACE = `${FRESH}&s=dsh:2`;
const WORK = `${FRESH}&w=2026-08-23T00:02:00.000Z`;
const PREF = "1:2026-08-23T00:00:00.000Z:e1:1:2026-08-23T00:01:00.000Z";

function decide(
  overrides: Partial<Parameters<typeof decideInboxSync>[0]> = {},
) {
  return decideInboxSync({
    requestedList: "shown",
    lastFetchedList: "shown",
    digest: FRESH,
    previousDigest: FRESH,
    storeSize: 8,
    now: INBOX_FULL_REFRESH_MS - 1,
    lastFullAt: 0,
    ...overrides,
  });
}

function page(
  overrides: Partial<InboxHeadsPageView> = {},
): InboxHeadsPageView {
  return {
    pinned: [],
    live: [],
    active_work: [],
    next_before: null,
    has_older: false,
    ...overrides,
  };
}

describe("decideInboxSync", () => {
  it("skips when the digest is unchanged and the full page is still fresh", () => {
    assert.deepEqual(decide(), { mode: "skip", replace: false });
  });

  it("loads a full page on first fill, list switch, or an empty digest", () => {
    assert.deepEqual(decide({ storeSize: 0, previousDigest: null, digest: FRESH }), {
      mode: "full",
      replace: true,
    });
    assert.deepEqual(decide({ requestedList: "hidden", digest: NEWER }), {
      mode: "full",
      replace: true,
    });
    assert.deepEqual(decide({ digest: "", previousDigest: FRESH }), {
      mode: "full",
      replace: false,
    });
  });

  it("patches only an event or pref change before the full-page clock is due", () => {
    assert.deepEqual(decide({ digest: NEWER }), { mode: "patch", replace: false });
    assert.deepEqual(decide({ digest: PREF }), { mode: "patch", replace: false });
    assert.deepEqual(decide({ digest: SURFACE }), { mode: "full", replace: false });
    assert.deepEqual(decide({ digest: WORK }), { mode: "full", replace: false });
  });

  it("forces a full page when the 45s clock is due, even if the digest moved", () => {
    assert.deepEqual(
      decide({
        digest: FRESH,
        now: INBOX_FULL_REFRESH_MS,
        lastFullAt: 0,
      }),
      { mode: "full", replace: false },
    );
    assert.deepEqual(
      decide({
        digest: NEWER,
        now: INBOX_FULL_REFRESH_MS,
        lastFullAt: 0,
      }),
      { mode: "full", replace: false },
    );
  });
});

describe("inbox heads sync mapping", () => {
  it("asks for a digest patch only in patch mode", () => {
    assert.deepEqual(
      inboxHeadsRequest({
        decision: { mode: "patch", replace: false },
        list: "shown",
        pageSize: 40,
        previousDigest: FRESH,
      }),
      { list: "shown", limit: 40, changed: true, since_digest: FRESH },
    );
    assert.deepEqual(
      inboxHeadsRequest({
        decision: { mode: "full", replace: true },
        list: "hidden",
        pageSize: 40,
        previousDigest: FRESH,
      }),
      { list: "hidden", limit: 40 },
    );
  });

  it("turns a patch page into headsTouched and a full page into live facts", () => {
    const touched = inboxHeadsFact({
      decision: { mode: "patch", replace: false },
      page: page({ patch: true, gone: ["crm:old"] }),
      list: "shown",
      pageSize: 40,
    });
    assert.equal(touched.kind, "headsTouched");
    if (touched.kind === "headsTouched") {
      assert.deepEqual(touched.gone, ["crm:old"]);
    }
    const fallback = inboxHeadsFact({
      decision: { mode: "patch", replace: false },
      page: page({ patch: false, has_older: true }),
      list: "shown",
      pageSize: 40,
    });
    assert.equal(fallback.kind, "liveChanged");
    const loaded = inboxHeadsFact({
      decision: { mode: "full", replace: true },
      page: page({ has_older: true }),
      list: "hidden",
      pageSize: 40,
    });
    assert.equal(loaded.kind, "liveLoaded");
    if (loaded.kind === "liveLoaded") {
      assert.equal(loaded.list, "hidden");
    }
  });

  it("omits activeWork on an empty patch so extras stay", () => {
    const touched = inboxHeadsFact({
      decision: { mode: "patch", replace: false },
      page: {
        pinned: [],
        live: [],
        next_before: null,
        has_older: false,
        patch: true,
        gone: [],
      },
      list: "shown",
      pageSize: 40,
    });
    assert.equal(touched.kind, "headsTouched");
    if (touched.kind === "headsTouched") {
      assert.equal(touched.activeWork, undefined);
      assert.deepEqual(touched.items, []);
    }
    const cleared = inboxHeadsFact({
      decision: { mode: "patch", replace: false },
      page: page({ patch: true, active_work: [] }),
      list: "shown",
      pageSize: 40,
    });
    assert.equal(cleared.kind, "headsTouched");
    if (cleared.kind === "headsTouched") {
      assert.deepEqual(cleared.activeWork, []);
    }
  });

  it("advances the full-page clock only after a live page, not a patch", () => {
    const clocks: InboxSyncClocks = {
      digest: FRESH,
      lastFullAt: 10,
      lastFetchedList: "shown",
    };
    assert.deepEqual(
      nextInboxSyncClocks(clocks, {
        fact: { kind: "headsTouched", items: [] },
        digest: NEWER,
        list: "shown",
        now: 99,
      }),
      { digest: NEWER, lastFullAt: 10, lastFetchedList: "shown" },
    );
    assert.deepEqual(
      nextInboxSyncClocks(clocks, {
        fact: {
          kind: "liveChanged",
          pinned: [],
          live: [],
          activeWork: [],
          nextBefore: null,
          hasOlder: false,
        },
        digest: NEWER,
        list: "shown",
        now: 99,
      }),
      { digest: NEWER, lastFullAt: 99, lastFetchedList: "shown" },
    );
    assert.deepEqual(
      nextInboxSyncClocks(clocks, {
        fact: {
          kind: "prefPatched",
          threadId: "crm:order-2",
          pref: {
            title: null,
            pinned: false,
            hidden: true,
            updated_at: "2026-08-23T00:03:00.000Z",
          },
        },
        digest: NEWER,
        list: "shown",
        now: 99,
      }),
      { digest: NEWER, lastFullAt: 10, lastFetchedList: "shown" },
    );
  });
});
