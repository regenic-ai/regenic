/** 75% of the 2Gi API cgroup, same ratio as the DSH 3072Mi heap on 4Gi. */
const API_OLD_SPACE_MB = 1536;
const LISTEN_MISS_LIMIT = 2;

function nodeOptionsWithHeap(current, heapMb = API_OLD_SPACE_MB) {
  const flag = `--max-old-space-size=${heapMb}`;
  if (typeof current === "string" && current.includes("--max-old-space-size")) {
    return current;
  }
  const trimmed = typeof current === "string" ? current.trim() : "";
  return trimmed ? `${trimmed} ${flag}` : flag;
}

function restartDelayMs(attempt) {
  const exponent = Math.max(0, Math.floor(attempt));
  return Math.min(15_000, 1_000 * 2 ** Math.min(exponent, 4));
}

function shouldRecycleWatcher({ everListened, misses, stopping, childAlive }) {
  return Boolean(
    childAlive && !stopping && everListened && misses >= LISTEN_MISS_LIMIT,
  );
}

module.exports = {
  API_OLD_SPACE_MB,
  LISTEN_MISS_LIMIT,
  nodeOptionsWithHeap,
  restartDelayMs,
  shouldRecycleWatcher,
};
