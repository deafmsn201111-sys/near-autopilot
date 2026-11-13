'use client';
import type { RepaySizing } from '@near-autopilot/core/loan-math';
import { useState } from 'react';
import { recommendationToPrepare, type RecommendationIntent } from '../lib/recommendation-intent';
import { amountText, pickRepay } from '../lib/repay-picker';
import { PrepareDialog } from './PrepareDialog';

const SLIDER_STEPS = 200;

/**
 * The amount of a loan repayment, chosen by the user: a typed amount, a slider and two shortcuts (the safe target,
 * the whole debt). The health factor after it is recomputed as the amount moves, in the loan-safety zone colours, and
 * the button prepares exactly that amount (the server still caps it at the debt and the source balance).
 */
export function RepayPicker({
  intent,
  sizing,
  account,
  label,
  signingEnabled,
}: {
  intent: RecommendationIntent & { action: 'repay' | 'repay_from_collateral' };
  sizing: RepaySizing;
  account: string;
  label: string;
  signingEnabled: boolean;
}) {
  const from = intent.action === 'repay' ? 'wallet' : 'collateral';
  const safeText = amountText(sizing.safeTokens, sizing.decimals);
  const maxText = amountText(sizing.maxTokens, sizing.decimals);
  // The card's own amount first (an agent may have sized it), so the text and the input agree.
  const [text, setText] = useState(
    intent.amount
      ? amountText(Number(intent.amount) / 10 ** sizing.decimals, sizing.decimals)
      : safeText,
  );
  const pick = pickRepay(sizing, from, text);
  const request = pick && recommendationToPrepare(intent, account, pick.raw);

  return (
    <div className="repay-picker">
      <label className="repay-amount">
        <span className="eyebrow">Amount to repay</span>
        <span className="repay-input">
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={sizing.maxTokens}
            step="any"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <span>{sizing.symbol}</span>
        </span>
      </label>
      <input
        type="range"
        aria-label="Amount to repay"
        min={0}
        max={sizing.maxTokens}
        step={sizing.maxTokens / SLIDER_STEPS}
        value={pick?.tokens ?? 0}
        onChange={(e) => setText(amountText(Number(e.target.value), sizing.decimals))}
      />
      <div className="repay-presets">
        <button type="button" className="btn secondary small" onClick={() => setText(safeText)}>
          To safe ({sizing.targetHf.toFixed(1)})
        </button>
        <button type="button" className="btn secondary small" onClick={() => setText(maxText)}>
          {sizing.wholeDebt ? 'Whole debt' : 'Max'}
        </button>
      </div>
      {pick ? (
        <p className="repay-after">
          ≈ ${pick.usd.toFixed(2)} · health factor {sizing.hfNow.toFixed(2)} →{' '}
          <span className={`safe-chip health-${pick.zone}`}>
            <span className="dot" aria-hidden="true" />
            {pick.hf === null ? 'loan repaid' : pick.hf.toFixed(2)}
          </span>
        </p>
      ) : (
        <p className="muted-note">Enter an amount to repay.</p>
      )}
      {request && (
        <PrepareDialog
          key={request.intent.action + pick.raw}
          request={request}
          label={label}
          signingEnabled={signingEnabled}
        />
      )}
    </div>
  );
}
