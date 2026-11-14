'use client';
import { useEffect, useState, type ComponentProps } from 'react';
import { shortHash } from '../lib/activity';
import { watchOtherBalances, type OtherBalance } from '../lib/hot-kit';
import { CHAIN_LABEL, DepositButton } from './DepositDialog';
import { HoldingsPanel, type OtherChainGroup } from './Holdings';
import { PortfolioSummary } from './PortfolioSummary';
import { Chip } from './primitives';

const BRING_CLASS = 'ds-btn ds-btn-secondary ds-btn-sm';

/** Balances the kit reads outside the NEAR account; stays empty while `enabled` is false. */
export function useOtherBalances(enabled: boolean): OtherBalance[] {
  const [balances, setBalances] = useState<OtherBalance[]>([]);
  useEffect(() => {
    if (!enabled) return setBalances([]);
    return watchOtherBalances(setBalances);
  }, [enabled]);
  return balances;
}

export const otherLabel = (b: OtherBalance) =>
  b.chain === 'hot' ? 'HOT balance' : `${CHAIN_LABEL[b.chain]} wallet · ${shortHash(b.address)}`;

const largestBringable = (groups: readonly OtherBalance[]) =>
  groups
    .flatMap((g) => g.items)
    .filter((i) => i.bringable)
    .sort((a, b) => b.usd - a.usd)[0];

function BringToNear({ account, groups }: { account: string; groups: readonly OtherBalance[] }) {
  const top = largestBringable(groups);
  return top ? (
    <DepositButton
      account={account}
      tokenId={top.tokenId}
      label="Bring to NEAR"
      className={BRING_CLASS}
    />
  ) : null;
}

/** The hero line's data: the total outside NEAR and Bring to NEAR for the largest bridgeable token. */
export function otherSummary(account: string | null, groups: readonly OtherBalance[]) {
  if (!account || groups.length === 0) return null;
  return {
    usd: groups.reduce((s, g) => s + g.usd, 0),
    tokens: groups.flatMap((g) => g.items).map((i) => ({ icon: i.icon, symbol: i.symbol })),
    action: <BringToNear account={account} groups={groups} />,
  };
}

/** A holdings group per other-chain wallet; each row brings its own token, the HOT balance only says where it is. */
export function otherGroups(
  account: string | null,
  groups: readonly OtherBalance[],
): OtherChainGroup[] {
  if (!account) return [];
  return groups.map((g) => ({
    key: g.key,
    label: otherLabel(g),
    items: g.items.map((i) => ({
      key: i.key,
      symbol: i.symbol,
      sub: `on ${i.chainName}`,
      amount: i.amount,
      usd: i.usd,
      logos: [{ icon: i.icon, symbol: i.symbol }],
      action: i.bringable ? (
        <DepositButton
          account={account}
          tokenId={i.tokenId}
          label="Bring to NEAR"
          className={BRING_CLASS}
        />
      ) : (
        <Chip>{g.chain === 'hot' ? 'Withdraw it in HOT Wallet' : 'Not bridgeable here'}</Chip>
      ),
    })),
  }));
}

/** The summary with the "+ $X on other chains" line while `account` is the connected one. */
export function LiveSummary({
  account,
  ...props
}: Omit<ComponentProps<typeof PortfolioSummary>, 'other'> & { account: string | null }) {
  const groups = useOtherBalances(account !== null);
  return <PortfolioSummary {...props} other={otherSummary(account, groups)} />;
}

/** The holdings table with a group per other-chain wallet while `account` is the connected one. */
export function LiveHoldings({
  account,
  ...props
}: Omit<ComponentProps<typeof HoldingsPanel>, 'other'> & { account: string | null }) {
  const groups = useOtherBalances(account !== null);
  return <HoldingsPanel {...props} other={otherGroups(account, groups)} />;
}
