import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APP_ATTENTION_BYTES,
  APP_ATTENTION_HINT,
  DISK_ATTENTION_HINT,
  DISK_CRITICAL_HINT,
  KERNEL_ATTENTION_BYTES,
  KERNEL_ATTENTION_HINT,
  KERNEL_CRITICAL_BYTES,
  KERNEL_CRITICAL_HINT,
  KERNEL_GONE_HINT,
  classifyDisk,
  classifyMemory,
  diskWatchCopy,
  formatBytes,
  memoryHint,
  memoryWatchCopy,
  portFromHttpOrigin,
  rememberKernelSample,
  volumeFromStatfs,
} from "../src/shared/host-watch.ts";

const GB = 1024 * 1024 * 1024;

describe("host watch", () => {
  it("treats a healthy disk as ok", () => {
    assert.equal(
      classifyDisk({ total_bytes: 500 * GB, free_bytes: 80 * GB }),
      "ok",
    );
  });

  it("flags a disk under 10% or 5 GB free", () => {
    assert.equal(
      classifyDisk({ total_bytes: 500 * GB, free_bytes: 40 * GB }),
      "attention",
    );
    assert.equal(
      classifyDisk({ total_bytes: 20 * GB, free_bytes: 3 * GB }),
      "attention",
    );
  });

  it("flags a disk under 5% or 1 GB free as critical", () => {
    assert.equal(
      classifyDisk({ total_bytes: 500 * GB, free_bytes: 20 * GB }),
      "critical",
    );
    assert.equal(
      classifyDisk({ total_bytes: 20 * GB, free_bytes: 800 * 1024 * 1024 }),
      "critical",
    );
  });

  it("flags our kernel and app memory, not the whole machine", () => {
    assert.equal(
      classifyMemory({
        kernel_bytes: 200 * 1024 * 1024,
        app_bytes: 180 * 1024 * 1024,
        kernel_alive: true,
      }),
      "ok",
    );
    assert.equal(
      classifyMemory({
        kernel_bytes: KERNEL_ATTENTION_BYTES,
        app_bytes: 180 * 1024 * 1024,
        kernel_alive: true,
      }),
      "attention",
    );
    assert.equal(
      classifyMemory({
        kernel_bytes: KERNEL_CRITICAL_BYTES,
        app_bytes: 180 * 1024 * 1024,
        kernel_alive: true,
      }),
      "critical",
    );
    assert.equal(
      classifyMemory({
        kernel_bytes: 200 * 1024 * 1024,
        app_bytes: APP_ATTENTION_BYTES,
        kernel_alive: true,
      }),
      "attention",
    );
    assert.equal(
      classifyMemory({
        kernel_bytes: null,
        app_bytes: 180 * 1024 * 1024,
        kernel_alive: false,
      }),
      "critical",
    );
  });

  it("formats bytes for the engine card", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(12 * 1024), "12 KB");
    assert.equal(formatBytes(86 * 1024 * 1024), "86 MB");
    assert.equal(formatBytes(1.2 * GB), "1.2 GB");
  });

  it("reads volume size from statfs blocks", () => {
    assert.deepEqual(
      volumeFromStatfs({
        bsize: 4096n,
        blocks: 131_072_000n,
        bavail: 20_971_520n,
      }),
      { total_bytes: 500 * GB, free_bytes: 80 * GB },
    );
  });

  it("writes disk copy with app data first, then the volume", () => {
    assert.equal(
      diskWatchCopy({
        kind: "ok",
        total_bytes: 500 * GB,
        free_bytes: 80 * GB,
        used_bytes: 420 * GB,
        data_bytes: 86 * 1024 * 1024,
        path: "/tmp",
        hint: null,
      }),
      "Data 86 MB · 80 GB free of 500 GB",
    );
    assert.equal(
      diskWatchCopy({
        kind: "attention",
        total_bytes: 20 * GB,
        free_bytes: 3 * GB,
        used_bytes: 17 * GB,
        data_bytes: 0,
        path: "/tmp",
        hint: DISK_ATTENTION_HINT,
      }),
      "Attention · Data 0 B · 3.0 GB free of 20 GB",
    );
  });

  it("writes memory copy as kernel plus app", () => {
    assert.equal(
      memoryWatchCopy({
        kind: "ok",
        kernel_bytes: 240 * 1024 * 1024,
        app_bytes: 180 * 1024 * 1024,
        used_bytes: 420 * 1024 * 1024,
        kernel_alive: true,
        hint: null,
      }),
      "Kernel 240 MB · App 180 MB",
    );
    assert.equal(
      memoryWatchCopy({
        kind: "critical",
        kernel_bytes: null,
        app_bytes: 180 * 1024 * 1024,
        used_bytes: 180 * 1024 * 1024,
        kernel_alive: false,
        hint: KERNEL_GONE_HINT,
      }),
      "Low · Kernel gone · App 180 MB",
    );
    assert.equal(
      memoryWatchCopy({
        kind: "critical",
        kernel_bytes: 1400 * 1024 * 1024,
        app_bytes: 180 * 1024 * 1024,
        used_bytes: 1580 * 1024 * 1024,
        kernel_alive: false,
        hint: KERNEL_GONE_HINT,
      }),
      "Low · Kernel gone (was 1.4 GB) · App 180 MB",
    );
  });

  it("explains a missing or oversized kernel", () => {
    assert.equal(
      memoryHint({
        kind: "critical",
        kernel_bytes: null,
        app_bytes: 0,
        kernel_alive: false,
      }),
      KERNEL_GONE_HINT,
    );
    assert.equal(
      memoryHint({
        kind: "critical",
        kernel_bytes: KERNEL_CRITICAL_BYTES,
        app_bytes: 0,
        kernel_alive: true,
      }),
      KERNEL_CRITICAL_HINT,
    );
    assert.equal(
      memoryHint({
        kind: "attention",
        kernel_bytes: KERNEL_ATTENTION_BYTES,
        app_bytes: 0,
        kernel_alive: true,
      }),
      KERNEL_ATTENTION_HINT,
    );
    assert.equal(
      memoryHint({
        kind: "attention",
        kernel_bytes: 0,
        app_bytes: APP_ATTENTION_BYTES,
        kernel_alive: true,
      }),
      APP_ATTENTION_HINT,
    );
    assert.match(DISK_CRITICAL_HINT, /1 GB/);
  });

  it("only samples loopback kernel ports", () => {
    assert.equal(portFromHttpOrigin("http://127.0.0.1:4370"), 4370);
    assert.equal(portFromHttpOrigin("http://localhost:3080"), 3080);
    assert.equal(portFromHttpOrigin("https://example.com:443"), null);
  });

  it("keeps the last kernel rss after the process dies", () => {
    const live = rememberKernelSample({
      pid: 42,
      alive: true,
      rss: 900 * 1024 * 1024,
    });
    assert.equal(live.kernel_alive, true);
    assert.equal(live.kernel_bytes, 900 * 1024 * 1024);
    const dead = rememberKernelSample({
      pid: 42,
      alive: false,
      rss: null,
      previous: live.previous,
    });
    assert.equal(dead.kernel_alive, false);
    assert.equal(dead.kernel_bytes, 900 * 1024 * 1024);
    const lost = rememberKernelSample({
      pid: null,
      alive: null,
      rss: null,
      previous: live.previous,
    });
    assert.equal(lost.kernel_alive, false);
    assert.equal(lost.kernel_bytes, 900 * 1024 * 1024);
  });
});
