import { label, nearblocks, type TokenLabel } from '../lib/token-label';
import { tokenRegistry } from '../lib/tokens';

function tip(t: TokenLabel): string {
  const lines = [t.name ? `${t.symbol} · ${t.name}` : t.symbol, t.id];
  if (t.verified) lines.push('Curated contract');
  else if (t.impersonates)
    lines.push('WARNING: uses the symbol of a curated token from another contract');
  else if (t.unknown) lines.push('No metadata stored yet');
  else lines.push('Symbol reported by the contract (unverified)');
  lines.push('Click: open on NearBlocks');
  return lines.join('\n');
}

/** A token as its symbol; the contract id is in the tooltip and the link goes to NearBlocks. */
export async function Token({ id }: { id: string }) {
  const t = label(id, await tokenRegistry());
  return (
    <span className={`token${t.verified ? '' : ' unverified'}`}>
      {t.impersonates && (
        <span className="flag" aria-label="possible impersonation">
          ⚠
        </span>
      )}
      <a
        href={nearblocks(id)}
        target="_blank"
        rel="noopener noreferrer"
        data-tip={tip(t)}
        aria-label={`${t.symbol} (${id}) on NearBlocks`}
      >
        {t.symbol}
      </a>
    </span>
  );
}

export async function Pair({ tokens }: { tokens: readonly string[] }) {
  return (
    <span className="pair">
      {tokens.map((id, i) => (
        <span key={id} className="pair">
          {i > 0 && <span className="sep">/</span>}
          <Token id={id} />
        </span>
      ))}
    </span>
  );
}

/** Plain-text symbol (for titles and option lists). */
export async function symbolOf(id: string): Promise<string> {
  return label(id, await tokenRegistry()).symbol;
}
