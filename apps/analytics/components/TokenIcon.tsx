'use client';
import { useState } from 'react';
import { iconView } from '../lib/token-label';

/** A token logo, only ever through <img> (an SVG there cannot run scripts); a letter placeholder when none or broken. */
export function TokenIcon({
  icon,
  symbol,
  size = 24,
}: {
  icon: string | null | undefined;
  symbol: string;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const view = iconView(icon, symbol, broken);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if ('letter' in view)
    return (
      <span className="token-icon placeholder" style={style} aria-hidden="true">
        {view.letter}
      </span>
    );
  return (
    <img
      className="token-icon"
      src={view.src}
      alt=""
      width={size}
      height={size}
      style={style}
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}

/** Two or more logos overlapping, for an LP position or a swap. */
export function TokenIcons({
  tokens,
  size = 24,
}: {
  tokens: readonly { icon: string | null | undefined; symbol: string }[];
  size?: number;
}) {
  return (
    <span className="token-icons">
      {tokens.map((t, i) => (
        <TokenIcon key={`${t.symbol}-${i}`} icon={t.icon} symbol={t.symbol} size={size} />
      ))}
    </span>
  );
}
