import type { RippleClient } from './client.js';
import { shutdownModules } from './registry.js';

export function installShutdownHandlers(client: RippleClient): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    client.services.logger.info({ signal }, 'shutting down');

    const timeout = setTimeout(() => {
      client.services.logger.error('shutdown timed out; forcing exit');
      process.exit(1);
    }, 5_000);
    timeout.unref();

    try {
      await shutdownModules(client);
      client.destroy();
      client.services.closeDb();
      client.services.logger.info('shutdown complete');
      clearTimeout(timeout);
      process.exit(0);
    } catch (error) {
      client.services.logger.error({ err: error }, 'shutdown failed');
      clearTimeout(timeout);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}
