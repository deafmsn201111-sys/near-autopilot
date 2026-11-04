import 'server-only';
import { loadDashboardEnv, type DashboardEnv } from '@near-autopilot/config';

let cached: DashboardEnv | undefined;

/** Validated lazily so `next build` does not require runtime secrets. */
export function getEnv(): DashboardEnv {
  cached ??= loadDashboardEnv();
  return cached;
}
