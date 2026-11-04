import type { PortfolioDto } from '@near-autopilot/core';
import { formatAmount, formatUsd } from '../lib/format';

type Holding = PortfolioDto['wallet'][number];

export function HoldingsTable({
  title,
  holdings,
  empty,
}: {
  title: string;
  holdings: Holding[];
  empty: string;
}) {
  return (
    <section className="block" aria-labelledby={`h-${title}`}>
      <h2 id={`h-${title}`}>{title}</h2>
      {holdings.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col" className="num">
                  Value
                </th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((h) => (
                <tr key={h.token}>
                  <th scope="row">{h.symbol}</th>
                  <td className="num">{formatAmount(h.raw, h.decimals)}</td>
                  <td className="num">{formatUsd(h.valueUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
