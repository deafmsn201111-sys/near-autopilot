import Link from 'next/link';
import { Env } from '../../components/Env';
import { ApiError, PageHeader, Section, Status, TableWrap, Tile } from '../../components/ui';
import { tryApi } from '../../lib/api';
import { int, ts } from '../../lib/format';

export const dynamic = 'force-dynamic';

interface Chain {
  chain: string;
  entries: number;
  firstAt: string;
  lastAt: string;
  verification:
    | { ok: true; entries: number; head: { seq: number; hash: string } | null }
    | { ok: false; entries: number; brokenAt: { seq: number; kind: string; detail: string } };
}
interface Entry {
  seq: number;
  at: string;
  type: string;
  runId: string | null;
  proposalId: string | null;
  payload: unknown;
  prevHash: string;
  hash: string;
}

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const h = (s: string) => `${s.slice(0, 8)}…${s.slice(-4)}`;

export default async function AuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  const chain = one((await searchParams).chain);
  const { data, error } = await tryApi<{
    chains: Chain[];
    unchainedRowsBeforeMigration0011: number;
    selected: string | null;
    entries: Entry[];
  }>(`/v1/analytics/audit?limit=60${chain ? `&chain=${encodeURIComponent(chain)}` : ''}`);
  if (!data) return <ApiError what="Audit chains" error={error} />;
  const broken = data.chains.filter((c) => !c.verification.ok);
  return (
    <>
      <PageHeader
        title="Audit trail"
        lead="Every audit event of every deployment is appended to a hash chain in Postgres: each entry commits to the one before it, so a changed, removed or reordered entry breaks the chain at that point. Re-verified from the database on every page load."
        meta={`${data.chains.length} chains`}
      />
      <div className="kpis">
        <Tile
          label="Chains verified"
          value={`${data.chains.length - broken.length} / ${data.chains.length}`}
          sub={
            broken.length === 0 ? (
              <Status code="OK" label="no break found" />
            ) : (
              <Status code="FAILED" label={`${broken.length} broken`} />
            )
          }
        />
        <Tile
          label="Chained entries"
          value={int(data.chains.reduce((s, c) => s + c.entries, 0))}
          sub="seq 1 to head, recomputed"
        />
        <Tile
          label="Before the chain"
          value={int(data.unchainedRowsBeforeMigration0011)}
          sub="older rows, kept unchanged, not covered"
        />
      </div>

      <Section
        title="Chains"
        note="One chain per deployment. The head hash commits to the whole history: publish it to anchor the trail outside this database. Verify locally with pnpm audit:verify."
      >
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Chain</th>
                <th>Verification</th>
                <th className="num">Entries</th>
                <th>Head</th>
                <th>First</th>
                <th>Last</th>
              </tr>
            </thead>
            <tbody>
              {data.chains.map((c) => (
                <tr key={c.chain}>
                  <td>
                    <Link href={`/audit?chain=${encodeURIComponent(c.chain)}`} className="row-link">
                      {c.chain}
                    </Link>{' '}
                    <Env env={c.chain} />
                  </td>
                  <td>
                    {c.verification.ok ? (
                      <Status code="OK" label="intact" />
                    ) : (
                      <Status
                        code="FAILED"
                        label={`broken at #${c.verification.brokenAt.seq} (${c.verification.brokenAt.kind})`}
                      />
                    )}
                  </td>
                  <td className="num">{int(c.entries)}</td>
                  <td
                    className="hash"
                    data-tip={
                      c.verification.ok && c.verification.head ? c.verification.head.hash : '—'
                    }
                  >
                    {c.verification.ok && c.verification.head
                      ? `#${c.verification.head.seq} ${h(c.verification.head.hash)}`
                      : '—'}
                  </td>
                  <td className="dim">{ts(c.firstAt)}</td>
                  <td className="dim">{ts(c.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Section>

      {data.selected && (
        <Section
          title={`Latest entries · ${data.selected}`}
          note="Hover a type for its payload, a hash for the full value."
        >
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th className="num">Seq</th>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Run</th>
                  <th>Prev hash → hash</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.seq}>
                    <td className="num">{e.seq}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{ts(e.at)}</td>
                    <td data-tip={JSON.stringify(e.payload, null, 1).slice(0, 700)}>
                      <b>{e.type}</b>
                    </td>
                    <td className="hash">{e.runId ? h(e.runId) : '—'}</td>
                    <td className="hash" data-tip={`prev ${e.prevHash}\nhash ${e.hash}`}>
                      {h(e.prevHash)} → {h(e.hash)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Section>
      )}
    </>
  );
}
