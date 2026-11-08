import { loadConfig } from './config.js';
import { createContainer } from './container.js';
import { buildApp } from './http/app.js';
import { startPoller } from './jobs/poller.js';
import { seedDemo } from './scripts/seed.js';
import { seedAdmin } from './scripts/seed-admin.js';

async function main() {
  const config = loadConfig();
  const container = createContainer(config);
  const { logger } = container.deps;

  if (config.NODE_ENV !== 'production' && !process.env.JWT_SECRET) {
    logger.warn('JWT_SECRET no definido: usando un secreto de desarrollo inseguro');
  }
  if (config.seedDemo) await seedDemo(container);
  await seedAdmin(container);

  const app = await buildApp(container);
  const stopPoller = startPoller(container);
  // Health checks periódicos de proveedores (portal admin).
  const runHealth = () =>
    void container.services.admin.providers.checkAll().catch((err) => logger.warn({ err }, 'provider health check failed'));
  runHealth();
  const healthTimer = setInterval(runHealth, config.PROVIDER_HEALTH_INTERVAL_MS);
  healthTimer.unref();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopPoller();
    clearInterval(healthTimer);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ mode: config.PROVIDERS_MODE, devRoutes: config.devRoutes }, `CuyPay API en http://${config.HOST}:${config.PORT}/v1`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
