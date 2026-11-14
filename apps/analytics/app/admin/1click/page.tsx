import { EmptyState, Facts, PageHeader, Section, Status, TableWrap } from '../../../components/ui';
import { ErrorState } from '../../../components/states';
import { adminApi, type AdminDeposits, type DepositState } from '../../../lib/admin';
import { ts } from '../../../lib/format';

const LABEL: Record<DepositState, string> = {
  waiting: 'Waiting for deposit',
  processing: 'Processing',
  success: 'Success',
  refunded: 'Refunded',
  failed: 'Failed',
  expired: 'Expired',
};

const fee = (bps: number | null) => (bps === null ? '—' : `${bps / 100}%`);

/** Admin screen 4: 1Click deposit quotes and the latest status the user's deposit screen saw. */
export default async function OneClickAdminPage() {
  let data: AdminDeposits;
  try {
    data = await adminApi<AdminDeposits>('/deposits');
  } catch (e) {
    return (
      <ErrorState
        what="1Click deposits"
        error={e instanceof Error ? e.message : null}
        hint="The analytics API did not answer /v1/admin/deposits."
      />
    );
  }
  return (
    <>
      <PageHeader
        title="1Click deposits"
        lead="Quotes from other chains and their latest status. The server re-checks unfinished deposits every 1–10 minutes; “Checked” is the last check. Unpaid 30 min past the deadline counts as expired."
      />
      <Section title="Last 7 days" note="UTC days, by quote time.">
        <Facts
          items={(Object.keys(LABEL) as DepositState[]).map((s) => [
            LABEL[s],
            String(data.counts[s]),
          ])}
        />
      </Section>
      <Section title="Recent quotes" note="Newest 100 of the last 7 days. Addresses are shortened.">
        {data.quotes.length === 0 ? (
          <EmptyState title="No quotes yet" />
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Account</th>
                  <th>From</th>
                  <th className="num">Amount</th>
                  <th>Deposit address</th>
                  <th>Refund to</th>
                  <th>Deadline</th>
                  <th className="num">Fee</th>
                  <th>Status</th>
                  <th>Checked</th>
                </tr>
              </thead>
              <tbody>
                {data.quotes.map((q) => (
                  <tr key={q.id}>
                    <td>{ts(q.createdAt)}</td>
                    <td>{q.accountId}</td>
                    <td>{q.chain ? `${q.asset} on ${q.chain}` : q.asset}</td>
                    <td className="num">{q.amount}</td>
                    <td>
                      <code>{q.depositAddress}</code>
                    </td>
                    <td>
                      <code>{q.refundTo}</code>
                    </td>
                    <td>{ts(q.deadline)}</td>
                    <td className="num">{fee(q.feeBps)}</td>
                    <td>
                      <Status code={q.status ?? 'not_checked'} label={LABEL[q.state]} />
                    </td>
                    <td>{q.statusAt ? ts(q.statusAt) : 'not checked'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Section>
    </>
  );
}
