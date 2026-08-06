import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { Client } from "pg";
import { loadEnv } from "@regenic/config";

@Injectable()
export class ConnectivityService implements OnModuleDestroy {
  private readonly logger = new Logger(ConnectivityService.name);
  private redis: IORedis | null = null;
  private queue: Queue | null = null;

  async probeAndLog(): Promise<void> {
    const env = loadEnv();

    const pg = new Client({ connectionString: env.DATABASE_URL });
    try {
      await pg.connect();
      await pg.query("select 1");
      this.logger.log("postgres: up");
    } catch (err) {
      this.logger.error(`postgres: down (${String(err)})`);
      throw err;
    } finally {
      await pg.end().catch(() => undefined);
    }

    this.redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    const pong = await this.redis.ping();
    this.logger.log(`redis: ${pong === "PONG" ? "up" : "down"}`);

    this.queue = new Queue("regenic-spike", {
      connection: this.redis.duplicate(),
    });
    await this.queue.waitUntilReady();
    this.logger.log("bullmq: queue ready");
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    this.redis?.disconnect();
  }
}
