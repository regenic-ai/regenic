import "./undici-process-guard";
import "reflect-metadata";
import { loadEnv } from "@regenic/config";
import { createHttpApp, enablePersonalCors, listenHttpApp } from "./http-app";
import { releaseListenPort, sidecarParentExited } from "./sidecar-shutdown";

const SIDECAR_SHUTDOWN_TIMEOUT_MS = 5_000;

async function bootstrap() {
  const env = loadEnv();
  const app = await createHttpApp();
  enablePersonalCors(app, env);
  app.enableShutdownHooks();
  await listenHttpApp(app, env.PORT, env.LISTEN_HOST);
  console.log(`api listening on ${env.LISTEN_HOST}:${env.PORT}`);
  const parentPid = Number(process.env.REGENIC_SIDECAR_PARENT_PID);
  if (Number.isSafeInteger(parentPid) && parentPid > 0) {
    const monitor = setInterval(() => {
      if (!sidecarParentExited(process.ppid, parentPid)) return;
      clearInterval(monitor);
      void (async () => {
        const server = app.getHttpServer() as { close: (callback: () => void) => void };
        await releaseListenPort((callback) => server.close(callback));
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`API sidecar shutdown exceeded ${SIDECAR_SHUTDOWN_TIMEOUT_MS}ms`));
          }, SIDECAR_SHUTDOWN_TIMEOUT_MS);
        });
        let exitCode = 0;
        try {
          await Promise.race([app.close(), deadline]);
        } catch (error) {
          console.error("API sidecar shutdown failed after parent exit", error);
          exitCode = 1;
        } finally {
          if (timeout) clearTimeout(timeout);
        }
        process.exit(exitCode);
      })().catch((error: unknown) => {
        console.error("API sidecar shutdown failed after parent exit", error);
        process.exit(1);
      });
    }, 250);
    monitor.unref();
  }
}

void bootstrap();
