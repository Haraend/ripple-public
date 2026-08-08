import type { RippleClient } from './client.js';
import type { Event, Module } from './types.js';

export function registerModule(client: RippleClient, module: Module): void {
  if (!module.enabled) {
    client.services.logger.info({ module: module.name }, 'module disabled; skipping');
    return;
  }

  client.modules.set(module.name, module);
  for (const command of module.commands) {
    const name = command.data.name;
    if (client.commands.has(name)) {
      throw new Error(`Duplicate command registration: /${name}`);
    }
    client.commands.set(name, command);
  }
  client.services.logger.info(
    { module: module.name, commands: module.commands.map((c) => c.data.name) },
    'module registered',
  );
}

export function registerEvents(client: RippleClient, events: readonly Event[]): void {
  for (const event of events) {
    const runner = (...args: Parameters<typeof event.execute> extends [RippleClient, ...infer R]
      ? R
      : never) => {
      void Promise.resolve(event.execute(client, ...args)).catch((error: unknown) => {
        client.services.logger.error({ err: error, event: event.name }, 'event handler failed');
      });
    };

    if (event.once) {
      client.once(event.name, runner);
    } else {
      client.on(event.name, runner);
    }
  }
}

export async function initModules(client: RippleClient): Promise<void> {
  // Sequential on purpose — module init order must be deterministic.
  for (const module of client.modules.values()) {
    if (module.init) {
      await module.init(client);
    }
  }
}

export async function shutdownModules(client: RippleClient): Promise<void> {
  const modules = [...client.modules.values()].reverse();
  for (const module of modules) {
    if (module.shutdown) {
      await module.shutdown();
    }
  }
}
