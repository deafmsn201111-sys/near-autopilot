'use client';
import { useEffect, useState } from 'react';
import { searchTokens, type DepositAsset } from '../lib/deposit';
import { Button } from './primitives';
import { TokenIcon } from './TokenIcon';

const POPULAR = ['USDC', 'USDT', 'ETH', 'SOL', 'BTC'];

/**
 * Pick a token: search by symbol, popular chips, a list with its logos. Arrow keys move, Enter picks, Esc goes back.
 * Shown inside the withdraw sheet in place of the form, never as a second dialog.
 */
export function TokenPicker<T extends DepositAsset>({
  title,
  tokens,
  selected,
  note,
  onPick,
  onBack,
}: {
  title: string;
  tokens: readonly T[];
  selected: string;
  note: (t: T) => string;
  onPick: (assetId: string) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const shown = searchTokens(tokens, query);
  const popular = POPULAR.flatMap((s) => tokens.find((t) => t.symbol === s) ?? []);
  const current = Math.min(active, Math.max(0, shown.length - 1));
  useEffect(() => {
    document.getElementById(`token-${current}`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive(Math.min(shown.length - 1, Math.max(0, current + step)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const t = shown[current];
      if (t) onPick(t.assetId);
    }
  }

  return (
    <div className="token-picker">
      <div className="token-picker-head">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back
        </Button>
        <h3>{title}</h3>
      </div>
      <input
        className="token-search"
        type="search"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        placeholder="Search by symbol"
        aria-label="Search by symbol"
        aria-controls="token-list"
        aria-activedescendant={shown[current] ? `token-${current}` : undefined}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKey}
      />
      {popular.length > 0 && !query && (
        <div className="token-chips">
          {popular.map((t) => (
            <button
              type="button"
              key={t.assetId}
              className={`token-chip${t.assetId === selected ? ' is-on' : ''}`}
              onClick={() => onPick(t.assetId)}
            >
              <TokenIcon icon={t.icon} symbol={t.symbol} size={20} />
              {t.symbol}
            </button>
          ))}
        </div>
      )}
      <ul className="token-list" id="token-list" role="listbox" aria-label={title}>
        {shown.map((t, i) => (
          <li
            key={t.assetId}
            id={`token-${i}`}
            role="option"
            aria-selected={t.assetId === selected}
            className={i === current ? 'is-active' : undefined}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(t.assetId)}
          >
            <TokenIcon icon={t.icon} symbol={t.symbol} size={32} />
            <span className="token-list-name">
              <b>{t.symbol}</b>
              <span className="muted-note">{note(t)}</span>
            </span>
            {t.assetId === selected && (
              <span className="token-check" aria-hidden="true">
                ✓
              </span>
            )}
          </li>
        ))}
        {shown.length === 0 && <li className="muted-note">No token matches “{query.trim()}”.</li>}
      </ul>
    </div>
  );
}

/** The selected token as a large button that opens the picker: logo, symbol, and where it is. */
export function TokenButton({
  token,
  where,
  disabled,
  onClick,
  label,
}: {
  token: DepositAsset | undefined;
  where: string;
  disabled: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className="token-button"
      disabled={disabled}
      onClick={onClick}
      aria-label={`${label}: ${token ? `${token.symbol} ${where}` : 'choose a token'}`}
    >
      {token ? (
        <>
          <TokenIcon icon={token.icon} symbol={token.symbol} size={28} />
          <span className="token-button-name">
            <b>{token.symbol}</b>
            <span className="muted-note">{where}</span>
          </span>
        </>
      ) : (
        <span className="muted-note">Loading…</span>
      )}
      <span className="token-button-caret" aria-hidden="true">
        ▾
      </span>
    </button>
  );
}
