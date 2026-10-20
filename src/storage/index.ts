import type { AdapterFactory } from '../types';
import { createLocalAdapter } from './local';

/** Available storage backends, selected with data-storage="…" on the script tag. */
export const adapters: Record<string, AdapterFactory> = {
  local: createLocalAdapter,
};
