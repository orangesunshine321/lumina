import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { startWorker } from "./services/worker.ts";
import { cleanupExpiredAdminSessions } from "./services/auth.ts";
import { cleanupOldAuthAttempts } from "./services/rateLimiter.ts";
import { runDatabaseBackup } from "./services/backup.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function startMaintenanceSweep(appInstance: Awaited<ReturnType<typeof buildApp>>) {
  const sweep = () =>
    Promise.all([cleanupExpiredAdminSessions(), cleanupOldAuthAttempts()]).catch((err) =>
      appInstance.log.error(err, "maintenance sweep failed"),
    );
  void sweep();
  setInterval(sweep, DAY_MS).unref();
}

/** Runs a consistent DB snapshot once at boot (so a fresh install has a
 * backup the same day) and then once every 24h — no host cron required. */
function startBackupSweep(appInstance: Awaited<ReturnType<typeof buildApp>>) {
  const sweep = () =>
    runDatabaseBackup()
      .then(() => appInstance.log.info("database backup snapshot written"))
      .catch((err) => appInstance.log.error(err, "database backup failed"));
  void sweep();
  setInterval(sweep, DAY_MS).unref();
}

const app = await buildApp();

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`pixset listening on http://${config.host}:${config.port} (${config.nodeEnv})`);
  startWorker();
  startMaintenanceSweep(app);
  startBackupSweep(app);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
