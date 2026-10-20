// Standalone local API (used by `npm run preview`). `npm run dev` starts it inside Vite instead.
import { existsSync } from 'node:fs';
import { startDevApi } from './dev';

if (existsSync('.env')) process.loadEnvFile('.env');
startDevApi();
