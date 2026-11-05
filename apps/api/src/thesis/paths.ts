import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** thesis/ at the repository root: raw inputs (committed), generated CSV and charts, and THESIS.md. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const THESIS_DIR = resolve(ROOT, 'thesis');
export const RAW_DIR = resolve(THESIS_DIR, 'data/raw');
export const OUT_DIR = resolve(THESIS_DIR, 'out');
