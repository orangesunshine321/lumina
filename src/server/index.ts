import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { startWorker } from "./services/worker.ts";
import { cleanupExpiredAdminSessions } from "./services/auth.ts";
import { cleanupOldAuthAttempts } from "./services/rateLimiter.ts";
import { runDatabaseBackup } from "./services/backup.ts";
import { cleanupStaleUploadTmp } from "./lib/storage.ts";
import { ensureSetupToken } from "./services/setupToken.ts";
import { db, schema } from "./db/client.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function startMaintenanceSweep(appInstance: Awaited<ReturnType<typeof buildApp>>) {
  const sweep = () =>
    Promise.all([
      cleanupExpiredAdminSessions(),
      cleanupOldAuthAttempts(),
      cleanupStaleUploadTmp(),
    ]).catch((err) => appInstance.log.error(err, "maintenance sweep failed"));
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

/** While no admin exists, print the first-run setup code prominently — the
 * installer greps it out of these logs and shows it to the operator. */
function announceSetupTokenIfNeeded(appInstance: Awaited<ReturnType<typeof buildApp>>) {
  const [admin] = db.select({ id: schema.adminUsers.id }).from(schema.adminUsers).limit(1).all();
  if (admin) return;
  const token = ensureSetupToken();
  appInstance.log.info(`PIXSET SETUP CODE: ${token}  (enter this on the setup screen to create your admin account)`);
}

const app = await buildApp();

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`pixset listening on http://${config.host}:${config.port} (${config.nodeEnv})`);
  announceSetupTokenIfNeeded(app);
  startWorker();
  startMaintenanceSweep(app);
  startBackupSweep(app);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Never let shutdown hang past Docker's SIGKILL grace period — if close
    // stalls (a stuck connection, a wedged job), exit anyway after 5s.
    setTimeout(() => process.exit(0), 5000).unref();
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
