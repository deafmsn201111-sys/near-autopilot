/**
 * Single source of truth for workspace dependency boundaries.
 * Consumed by eslint.config.mjs (editor feedback) and scripts/check-boundaries.mjs (CI gate).
 *
 * Layering (arrows point at what a package MAY import):
 *
 *   apps/api ─► agents, policy-engine, tx-execution, adapters, db, config, financial-engine, core
 *   agents, policy-engine ─► financial-engine ─► core
 *   orchestrator ─► financial-engine, core    (policy and execution are reached only through ports it defines;
 *                                              its TESTS may use the real policy-engine and tx-execution)
 *   rhea / burrow / near adapters ─► core     (adapters never import each other)
 *   tx-execution ─► core                      (talks to adapters only through core ports)
 *   db ─► config ─► core
 */
export const ALLOWED = {
  '@near-autopilot/core': [],
  '@near-autopilot/config': ['@near-autopilot/core'],
  '@near-autopilot/financial-engine': ['@near-autopilot/core'],
  '@near-autopilot/near-adapter': ['@near-autopilot/core'],
  '@near-autopilot/rhea-adapter': ['@near-autopilot/core'],
  '@near-autopilot/rhea-dcl-adapter': ['@near-autopilot/core'],
  '@near-autopilot/burrow-adapter': ['@near-autopilot/core'],
  '@near-autopilot/agents': ['@near-autopilot/core', '@near-autopilot/financial-engine'],
  '@near-autopilot/policy-engine': ['@near-autopilot/core', '@near-autopilot/financial-engine'],
  '@near-autopilot/orchestrator': ['@near-autopilot/core', '@near-autopilot/financial-engine'],
  '@near-autopilot/tx-execution': ['@near-autopilot/core'],
  '@near-autopilot/db': ['@near-autopilot/config'],
  '@near-autopilot/api': [
    '@near-autopilot/agents',
    '@near-autopilot/burrow-adapter',
    '@near-autopilot/config',
    '@near-autopilot/core',
    '@near-autopilot/db',
    '@near-autopilot/financial-engine',
    '@near-autopilot/near-adapter',
    '@near-autopilot/orchestrator',
    '@near-autopilot/policy-engine',
    '@near-autopilot/rhea-adapter',
    '@near-autopilot/rhea-dcl-adapter',
    '@near-autopilot/tx-execution',
  ],
  // Read-only analytics UI for the shadow collector: HTTP to the analytics API only.
  '@near-autopilot/analytics': ['@near-autopilot/config', '@near-autopilot/core'],
};

/**
 * Extra packages a package's TEST files (and devDependencies) may use. Production source is still held to ALLOWED,
 * so e.g. the orchestrator can be integration-tested against the real policy engine without ever importing it.
 */
export const TEST_ALLOWED = {
  '@near-autopilot/orchestrator': ['@near-autopilot/policy-engine', '@near-autopilot/tx-execution'],
};

/** Where each workspace package lives. */
export const LOCATIONS = {
  '@near-autopilot/core': 'packages/core',
  '@near-autopilot/config': 'packages/config',
  '@near-autopilot/financial-engine': 'packages/financial-engine',
  '@near-autopilot/near-adapter': 'packages/near-adapter',
  '@near-autopilot/rhea-adapter': 'packages/rhea-adapter',
  '@near-autopilot/rhea-dcl-adapter': 'packages/rhea-dcl-adapter',
  '@near-autopilot/burrow-adapter': 'packages/burrow-adapter',
  '@near-autopilot/agents': 'packages/agents',
  '@near-autopilot/policy-engine': 'packages/policy-engine',
  '@near-autopilot/orchestrator': 'packages/orchestrator',
  '@near-autopilot/tx-execution': 'packages/tx-execution',
  '@near-autopilot/db': 'packages/db',
  '@near-autopilot/api': 'apps/api',
  '@near-autopilot/analytics': 'apps/analytics',
};
