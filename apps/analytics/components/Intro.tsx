import Link from 'next/link';
import { Icon } from './icons';

export function Intro() {
  return (
    <section className="ds-panel intro" aria-labelledby="intro-h">
      <div>
        <h1 id="intro-h">An analyst for your DeFi portfolio. You keep the keys.</h1>
        <p className="intro-sub">
          Reads a real NEAR wallet, ranks what to do with numbers after costs, and builds the exact
          transaction for you to sign.
        </p>
        <ol>
          <li>
            <b>Reads your wallet</b>
            <span>Balances, loans, liquidity and staking, straight from the chain.</span>
          </li>
          <li>
            <b>Agents check it</b>
            <span>
              Loan safety, concentration, idle money, liquidity ranges, with numbers after costs.
            </span>
          </li>
          <li>
            <b>You sign in your wallet</b>
            <span>The exact transaction you previewed. Nothing else.</span>
          </li>
        </ol>
      </div>
      <div className="trust">
        <h2>
          <Icon name="shield" size={20} />
          Why you can trust it
        </h2>
        <ul>
          <li>
            <Icon name="lock" size={14} />
            <span>
              <b>No keys on our server.</b> It cannot sign anything.
            </span>
          </li>
          <li>
            <Icon name="shield" size={14} />
            <span>
              <b>Every transaction is checked</b> before your wallet sees it: allowed contracts and
              methods, gas and amount limits.
            </span>
          </li>
          <li>
            <Icon name="eye" size={14} />
            <span>
              <b>You see every call</b> in full before you sign.
            </span>
          </li>
        </ul>
        <Link className="link" href="/policy">
          See the checks, including a blocked attack
        </Link>
      </div>
    </section>
  );
}
