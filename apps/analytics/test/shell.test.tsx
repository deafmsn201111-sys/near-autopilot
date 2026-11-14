import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const nav = vi.hoisted(() => ({ path: '/' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ refresh: () => undefined }),
}));

const { ContextStrip } = await import('../components/ContextStrip');
const { Intro } = await import('../components/Intro');
const { TabBar } = await import('../components/Nav');
const { DepositButton } = await import('../components/DepositDialog');
const { portfolioMode } = await import('../lib/portfolio-mode');

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const mode = (account: string, connected: string, isAccount = true) =>
  portfolioMode({ isAccount, account, connected, verified: false, signingEnabled: true });

describe('ContextStrip', () => {
  it('demo: hatched chip in a dashed frame, a real wallet to see and a wallet to connect', () => {
    const out = html(<ContextStrip mode={mode('', '', false)} account="" current="demo-5000" />);
    expect(out).toContain('ctx ctx-dashed');
    expect(out).toContain('ds-chip ds-chip-demo');
    expect(out).toContain('Demo · simulated');
    expect(out).toContain('href="/?p=account&amp;account=near"');
    expect(out).toContain('Connect your wallet');
    expect(out).not.toContain('ds-chip-safe');
  });

  it('read-only: amber chip in a dashed frame, never "Your wallet"', () => {
    const out = html(
      <ContextStrip mode={mode('near', 'bob.near')} account="near" current="account" />,
    );
    expect(out).toContain('ctx ctx-dashed');
    expect(out).toContain('ds-chip ds-chip-watch');
    expect(out).toContain('<b>near</b> is not your connected wallet.');
    expect(out).toContain('href="/?p=account&amp;account=bob.near"');
    expect(out).not.toContain('ds-chip-safe');
  });

  it('read-only without a connected wallet does not claim the account is not yours', () => {
    const out = html(<ContextStrip mode={mode('near', '')} account="near" current="account" />);
    expect(out).toContain('is open read-only.');
    expect(out).not.toContain('Back to my wallet');
  });

  it('your wallet: mint chip, no dashed frame, Switch view lists both demos and the lookup', () => {
    const out = html(
      <ContextStrip
        mode={mode('alice.near', 'alice.near')}
        account="alice.near"
        current="account"
      />,
    );
    expect(out).not.toContain('ctx-dashed');
    expect(out).toContain('ds-chip ds-chip-safe');
    expect(out).toContain('Your wallet');
    expect(out).toContain('Switch view');
    expect(out).toContain('href="/?p=demo-5000"');
    expect(out).toContain('href="/?p=demo-500"');
    expect(out).toContain('name="account"');
  });

  it('marks the open view in the Switch view menu', () => {
    const out = html(<ContextStrip mode={mode('', '', false)} account="" current="demo-500" />);
    expect(out).toMatch(/aria-current="page" href="\/\?p=demo-500"/);
  });
});

describe('Intro', () => {
  it('has three numbered stages and the trust column with the /policy link', () => {
    const out = html(<Intro />);
    expect(out.match(/<li/g)).toHaveLength(6);
    expect(out).toContain('Why you can trust it');
    expect(out).toContain('href="/policy"');
  });
});

describe('TabBar', () => {
  it('shows the three main sections and marks the current one', () => {
    nav.path = '/activity';
    const out = html(<TabBar />);
    expect(out.match(/<a /g)).toHaveLength(3);
    expect(out).toMatch(/aria-current="page" href="\/activity"/);
    expect(out).not.toMatch(/aria-current="page" href="\/"/);
  });
});

describe('deposit entry point', () => {
  it('is called "Add funds"', () => {
    expect(html(<DepositButton account="alice.near" />)).toContain('Add funds');
  });
});
