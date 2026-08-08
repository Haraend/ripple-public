import type { Module } from '../../core/types.js';
import { configCommand } from './commands/config.js';
import { helpCommand } from './commands/help.js';
import { ownerCommand } from './commands/owner.js';
import { pingCommand } from './commands/ping.js';

export const coreModule: Module = {
  name: 'core',
  enabled: true,
  commands: [pingCommand, helpCommand, configCommand, ownerCommand],
};
