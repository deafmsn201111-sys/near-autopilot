import Link from 'next/link';
import { cookies } from 'next/headers';
import { accountIdSchema } from '@near-autopilot/core';
import { ErrorState } from '../../components/states';
import { EmptyState } from '../../components/ui';
import { WalletButton } from '../../components/WalletButton';
import { headline, shortHash, STATUS, stepLines, type TimelineItem } from '../../lib/activity';
import { accountEvents } from '../../lib/product';

export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;
const EXAMPLE = 'autopilot-test.near';

const fmt = (iso: string) =>
  `${new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })} UTC`;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

function Item({ item }: { item: TimelineItem }) {
  const status = item.type === 'cascade' ? STATUS[item.status] : null;
  return (
    <li className={`tl ${status?.tone ?? 'neutral'}`}>
      <span className="tl-dot" aria-hidden="true" />
      <div className="tl-body">
        <div className="tl-head">
          <b>{headline(item)}</b>
          <span className="muted-note">
            {fmt(item.at)}
            {status && ` · ${status.label}`}
          </span>
        </div>
        {item.type === 'cascade' && item.signed.length > 0 && (
          <ul>
            {item.signed.map((s, i) => (
              <li key={s.hash}>
                {stepLines(item, i).join(' · ')}{' '}
                <a
                  className="muted-note"
                  href={`https://nearblocks.io/txns/${s.hash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortHash(s.hash)} ↗
                </a>
              </li>
            ))}
          </ul>
        )}
        {item.type === 'cascade' && item.signed.length === 0 && item.preview.length > 0 && (
          <ul>
            {item.preview.map((line, i) => (
              <li key={`${i}-${line}`}>{line}</li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/** What this account did through Autopilot, newest first, from the events our server recorded. */
export default async function ActivityPage({ searchParams }: { searchParams: Promise<Search> }) {
  const raw =
    one((await searchParams).account) || ((await cookies()).get('np_account')?.value ?? '');
  const account = accountIdSchema.safeParse(raw.trim().toLowerCase());
  const title = (
    <div className="page-title">
      <h1>Activity</h1>
      <p>
        What you did here: analyses, prepared moves and the transactions you signed, as NEAR
        confirmed them.
      </p>
    </div>
  );
  if (!account.success)
    return (
      <>
        {title}
        <EmptyState title="Connect your wallet to see what you did here" action={<WalletButton />}>
          <Link href={`/activity?account=${EXAMPLE}`} className="link">
            See a real example → {EXAMPLE}
          </Link>
        </EmptyState>
      </>
    );
  const { data, error } = await accountEvents(account.data);
  return (
    <>
      {title}
      <p className="muted-note">
        Account <b>{account.data}</b>
      </p>
      {!data ? (
        <ErrorState what="The activity" error={error} />
      ) : data.items.length === 0 ? (
        <EmptyState title="Nothing here yet">
          {data.owner
            ? 'Analyse your portfolio and prepare a move: it shows up here.'
            : 'No signed transactions through Autopilot yet. Analyses and unsigned moves are shown only to the owner after verifying ownership.'}
        </EmptyState>
      ) : (
        <>
          {!data.owner && (
            <p className="muted-note">
              Only transactions confirmed on NEAR are public. Analyses and unsigned moves are shown
              only to the owner after verifying ownership.
            </p>
          )}
          <ol className="timeline">
            {data.items.map((item) => (
              <Item
                key={`${item.type}-${item.at}-${'cascadeId' in item ? item.cascadeId : ''}`}
                item={item}
              />
            ))}
          </ol>
        </>
      )}
    </>
  );
}
