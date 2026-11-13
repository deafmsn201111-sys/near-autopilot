import 'server-only';

// Next bundles server actions (action-browser layer) apart from page rendering (rsc layer), each with its own copy
// of a module, so state that both must see lives once per process.
const store = ((globalThis as Record<symbol, Map<string, unknown>>)[
  Symbol.for('near-autopilot.process-state')
] ??= new Map());

export const processWide = <T>(name: string, init: () => T): T => {
  if (!store.has(name)) store.set(name, init());
  return store.get(name) as T;
};
