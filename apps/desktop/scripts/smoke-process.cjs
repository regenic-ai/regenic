function observeChild(child) {
  const exited = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  return {
    exited,
    async stop(timeoutMs = 5000) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      let timer;
      try {
        return await Promise.race([
          exited,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Smoke child cleanup timed out")), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function runWithFailureCleanup(main, cleanup) {
  try {
    await main();
  } catch (error) {
    process.exitCode = 1;
    console.error(error);
    try {
      await cleanup();
    } catch (cleanupError) {
      console.error("Smoke failure cleanup failed", cleanupError);
    }
  }
}

module.exports = { observeChild, runWithFailureCleanup };
