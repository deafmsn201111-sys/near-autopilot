import { EmptyState, PageHeader, Section, TableWrap } from '../../../components/ui';
import { ErrorState } from '../../../components/states';
import { adminApi, type Funnel } from '../../../lib/admin';

const STEPS = [
  ['connect', 'Connects (client-reported)'],
  ['analyse', 'Analyses'],
  ['prepare', 'Cascades built'],
  ['signed', 'Signed (RPC-verified)'],
  ['accounts', 'Unique wallets'],
] as const;

/** Admin screen 2: does anyone go from connect to a signed transaction. */
export default async function FunnelPage() {
  let funnel: Funnel;
  try {
    funnel = await adminApi<Funnel>('/funnel');
  } catch (e) {
    return <ErrorState what="Funnel" error={e instanceof Error ? e.message : null} />;
  }
  return (
    <>
      <PageHeader
        title="Funnel"
        lead="Connect → analyse → cascade built → signed, from the events table."
      />
      <Section
        title="Last 7 days"
        note="UTC days. Connects are reported by the browser and prove nothing; signed is confirmed by NEAR RPC."
      >
        {funnel.total.accounts === 0 ? (
          <EmptyState title="No data yet">No wallet has connected in the last 7 days.</EmptyState>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  {STEPS.map(([k, label]) => (
                    <th key={k} className="num">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {funnel.days.map((d) => (
                  <tr key={d.day}>
                    <td>{d.day}</td>
                    {STEPS.map(([k]) => (
                      <td key={k} className="num">
                        {d[k]}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <td>
                    <b>7 days</b>
                  </td>
                  {STEPS.map(([k]) => (
                    <td key={k} className="num">
                      <b>{funnel.total[k]}</b>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </TableWrap>
        )}
      </Section>
    </>
  );
}
