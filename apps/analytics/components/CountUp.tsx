'use client';
import { useEffect, useRef, useState } from 'react';
import { money, signedMoney } from '../lib/format';

const DURATION_MS = 600;

const FORMAT = {
  money: (v: number) => {
    const [whole, cents] = money(v, true).split('.');
    return (
      <>
        {whole}
        {cents && <span className="sum-cents">.{cents}</span>}
      </>
    );
  },
  signed: (v: number) => signedMoney(v).text,
} as const;

/** Counts from the last shown value to a new one (after a transaction); the first render and reduced motion show it at once. */
export function CountUp({ value, kind }: { value: number; kind: keyof typeof FORMAT }) {
  const [shown, setShown] = useState(value);
  const last = useRef(value);
  useEffect(() => {
    const from = last.current;
    last.current = value;
    if (from === value || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / DURATION_MS);
      setShown(from + (value - from) * (1 - (1 - k) ** 3));
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return FORMAT[kind](shown);
}
