import type { AdapterFactory } from '../types';
import { createLocalAdapter } from './local';
import { createRemoteAdapter } from './remote';

/** Available storage backends, selected with data-storage="…" on the script tag. */
export const adapters: Record<string, AdapterFactory> = {
  local: createLocalAdapter,
  remote: createRemoteAdapter,
};
