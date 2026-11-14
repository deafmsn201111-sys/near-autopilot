import Link from 'next/link';
import type { PortfolioMode } from '../lib/portfolio-mode';
import { AccountForm } from './AccountForm';
import { Icon } from './icons';
import { PORTFOLIOS, type PortfolioId } from './PortfolioSwitch';
import { Chip } from './primitives';
import { ConnectButton, portfolioUrl } from './WalletButton';

export function SwitchView({
  current,
  connected,
  label = 'Switch view',
}: {
  current: PortfolioId | 'account';
  connected: string;
  label?: string;
}) {
  return (
    <details className="ctx-menu">
      <summary className="ds-btn ds-btn-ghost ds-btn-sm">
        {label}
        <Icon name="down" size={14} />
      </summary>
      <div className="ctx-menu-pop">
        {connected && <Link href={portfolioUrl(connected)}>Your wallet · {connected}</Link>}
        {PORTFOLIOS.map((p) => (
          <Link
            key={p.id}
            href={`/?p=${p.id}`}
            aria-current={p.id === current ? 'page' : undefined}
          >
            {p.label}
          </Link>
        ))}
        <AccountForm compact />
      </div>
    </details>
  );
}

export function ContextStrip({
  mode,
  account,
  current,
  connected = '',
}: {
  mode: PortfolioMode;
  account: string;
  current: PortfolioId | 'account';
  connected?: string;
}) {
  const mine = connected || mode.backTo || (mode.kind === 'mine' ? account : '');
  if (mode.kind === 'demo')
    return (
      <div className="ctx ctx-dashed">
        <Chip tone="demo">Demo · simulated</Chip>
        <p>
          A sample portfolio priced at live market rates. Nothing here is a real account, so nothing
          can be signed.
        </p>
        <Link className="ds-btn ds-btn-secondary ds-btn-sm" href={portfolioUrl('near')}>
          See a real wallet
        </Link>
        {mine ? (
          <Link className="ds-btn ds-btn-primary ds-btn-sm" href={portfolioUrl(mine)}>
            Back to my wallet
          </Link>
        ) : (
          <ConnectButton className="ds-btn ds-btn-primary ds-btn-sm">
            Connect your wallet
          </ConnectButton>
        )}
        <SwitchView current={current} connected={mine} />
      </div>
    );
  if (mode.kind === 'readonly')
    return (
      <div className="ctx ctx-dashed">
        <Chip tone="watch" icon={<Icon name="eye" size={12} />}>
          Read-only
        </Chip>
        <p>
          <b>{account}</b> {mode.backTo ? 'is not your connected wallet.' : 'is open read-only.'}{' '}
          {mode.note}
        </p>
        {mode.backTo && (
          <Link className="ds-btn ds-btn-secondary ds-btn-sm" href={portfolioUrl(mode.backTo)}>
            <Icon name="back" size={14} />
            Back to my wallet
          </Link>
        )}
        <SwitchView current={current} connected={mine} label="Look up another" />
      </div>
    );
  return (
    <div className="ctx">
      <Chip tone="safe" icon={<Icon name="shield" size={12} />}>
        {mode.label}
      </Chip>
      <p>
        <b>{account}</b> · {mode.note}
      </p>
      <SwitchView current={current} connected={mine} />
    </div>
  );
}
