import { Facts, PageHeader, Section, Status, TableWrap } from '../../components/ui';
import { ErrorState } from '../../components/states';
import { adminApi, type Spend } from '../../lib/admin';
import { setDailyCap, setDeposit, setLlmEnabled } from './actions';
import { ControlForm } from './ControlForm';

const money = (n: number) => {
  const digits = n > 0 && n < 1 ? 4 : 2;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: 4 })}`;
};
const STALE_DEPOSIT_DAYS = 7;

function runOut(d: NonNullable<Spend['deposit']>) {
  const stale =
    d.enteredDaysAgo >= STALE_DEPOSIT_DAYS
      ? ' — re-enter it: spend older than 7 days is purged'
      : '';
  return `${d.runOutDate ?? 'no spend yet'} · ${money(d.leftUsd)} left of ${money(d.balanceUsd)} entered ${d.enteredDaysAgo} d ago${stale}`;
}

/** Admin, loopback only: what the AI costs and the controls to stop it (Spend and Controls screens). */
export default async function AdminPage() {
  let spend: Spend;
  try {
    spend = await adminApi<Spend>('/spend');
  } catch (e) {
    return (
      <ErrorState
        what="Admin"
        error={e instanceof Error ? e.message : null}
        hint="The analytics API did not answer the admin routes. Check that ADMIN_API_TOKEN is set for analytics-api and analytics-admin."
      />
    );
  }
  const d = spend.deposit;
  const cap = `${money(spend.capUsd)} cap${spend.capIsDefault ? ' (LLM_DAILY_CAP_USD)' : ''}`;
  return (
    <>
      <PageHeader
        title="Admin"
        lead="AI spend and controls. Reachable only through the SSH tunnel; the public site answers 404 here."
      />
      <Section title="Spend" note="UTC days. Calls are kept 7 days.">
        <Facts
          items={[
            ['Today', `${money(spend.todayUsd)} of ${cap}`],
            [
              'Average per analysis',
              spend.avgPerAnalysisUsd === null
                ? 'no analyses in 7 days'
                : `${money(spend.avgPerAnalysisUsd)} over ${spend.analyses} analyses`,
            ],
            ['Daily average, 7 days', money(spend.dailyAvgUsd)],
            [
              'Deposit run-out (estimate)',
              d === null ? 'enter the deposit balance below' : runOut(d),
            ],
          ]}
        />
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Spend</th>
              </tr>
            </thead>
            <tbody>
              {spend.days.map((r) => (
                <tr key={r.day}>
                  <td>{r.day}</td>
                  <td className="num">{money(r.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Analyses</th>
                <th className="num">Spend, 7 days</th>
              </tr>
            </thead>
            <tbody>
              {spend.models.length === 0 ? (
                <tr>
                  <td colSpan={3}>No analyses in 7 days.</td>
                </tr>
              ) : (
                spend.models.map((m) => (
                  <tr key={m.model}>
                    <td>{m.model}</td>
                    <td className="num">{m.analyses}</td>
                    <td className="num">{money(m.usd)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TableWrap>
      </Section>
      <Section title="Controls" note="Each change applies to the next analysis; no restart.">
        <Facts
          items={[
            [
              'AI analysis',
              <Status
                key="llm"
                code={spend.llmEnabled ? 'OK' : 'failed'}
                label={spend.llmEnabled ? 'On' : 'Off (kill switch)'}
              />,
            ],
          ]}
        />
        <ControlForm
          action={setLlmEnabled}
          submit={spend.llmEnabled ? 'Turn AI off' : 'Turn AI on'}
          danger={spend.llmEnabled}
        >
          <input type="hidden" name="llmEnabled" value={spend.llmEnabled ? 'off' : 'on'} />
        </ControlForm>
        <ControlForm action={setDailyCap} submit="Save cap">
          <label htmlFor="dailyCapUsd">Daily cap, USD</label>
          <input
            id="dailyCapUsd"
            name="dailyCapUsd"
            type="number"
            min="0.01"
            max="1000"
            step="0.01"
            required
            defaultValue={spend.capUsd}
          />
        </ControlForm>
        <ControlForm action={setDeposit} submit="Save balance">
          <label htmlFor="depositUsd">Provider deposit balance now, USD</label>
          <input
            id="depositUsd"
            name="depositUsd"
            type="number"
            min="0.01"
            max="1000000"
            step="0.01"
            required
            placeholder={d ? `${d.leftUsd.toFixed(2)} left by our estimate` : undefined}
          />
        </ControlForm>
      </Section>
    </>
  );
}
