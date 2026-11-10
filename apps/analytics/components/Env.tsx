/**
 * Where a row came from. Every deployment shares one database; this label keeps simulated portfolios, shadow analysis on
 * real mainnet data, chain data and attack fixtures apart.
 */
const ENV: Record<string, { label: string; tip: string }> = {
  'simulation:mainnet': {
    label: 'Shadow mainnet',
    tip: 'Simulated demo portfolio analysed on REAL mainnet market data (read-only). Nothing is sent.',
  },
  'chain:mainnet': { label: 'Mainnet', tip: 'Mainnet chain data.' },
};

export function Env({ env, fixture = false }: { env: string; fixture?: boolean }) {
  if (fixture)
    return (
      <span
        className="chip fixture"
        data-tip="FIXTURE: synthetic attack input, not market or chain data"
        tabIndex={0}
      >
        Fixture
      </span>
    );
  const e = ENV[env] ?? { label: env, tip: env };
  return (
    <span className="chip" data-tip={e.tip} tabIndex={0}>
      {e.label}
    </span>
  );
}
