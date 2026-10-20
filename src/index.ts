import { readConfig, type PreConfig } from './config';
import { adapters } from './storage';
import { App } from './ui/app';
import { LOG } from './util';

// No runtime exports: the IIFE build would assign them to a global and clobber window.PrototypeComments.
const version = __VERSION__;

declare global {
  interface Window {
    PrototypeComments?: PreConfig | PublicApi;
    __prototypeCommentsLoaded?: boolean;
  }
}

export interface PublicApi {
  version: string;
  /** Enter comment mode, as if the user pressed C. */
  comment(): void;
  toggleSidebar(open?: boolean): void;
  exportData(): Promise<unknown>;
}

function boot() {
  // Guard against the script being included twice.
  if (window.__prototypeCommentsLoaded) return;
  window.__prototypeCommentsLoaded = true;

  const pre = (window.PrototypeComments ?? {}) as PreConfig;
  const config = readConfig(pre);

  let factory = adapters[config.storage];
  if (!factory) {
    console.warn(LOG, `Unknown storage "${config.storage}", falling back to local.`);
    factory = adapters.local;
  }
  const app = new App(config, factory({ project: config.project, users: config.users, endpoint: config.endpoint, notion: config.notion }));

  const api: PublicApi = {
    version,
    comment: () => void app.setPlacing(true),
    toggleSidebar: (open) => app.setSidebar(open ?? !app.state.sidebarOpen),
    exportData: async () => app.store.exportData?.(),
  };
  window.PrototypeComments = api;

  const start = () => app.mount().catch((err) => console.error(LOG, 'failed to start', err));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

boot();
