import type { Event } from '../core/types.js';

/**
 * Phase 1 stub — Phase 2 wires autoleave / empty-channel timers here.
 * Keeping the event registered so the intent path is exercised early.
 */
export const voiceStateUpdateEvent: Event<'voiceStateUpdate'> = {
  name: 'voiceStateUpdate',
  execute(_client, _oldState, _newState) {
    // no-op in Phase 1
  },
};
