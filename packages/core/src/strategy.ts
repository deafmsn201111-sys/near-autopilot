import { z } from 'zod';

export const STRATEGY_IDS = ['conservative', 'balanced', 'aggressive'] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];
export const DEFAULT_STRATEGY: StrategyId = 'balanced';

export interface Strategy {
  readonly label: string;
  /** At or above this health factor the loan is "Safe" and no repay card appears. */
  readonly healthyAt: number;
  /** A repay is sized to bring the health factor back to this. */
  readonly targetHealthFactor: number;
  /** Below this the repay card is a warning. */
  readonly warningBelow: number;
  /** Share of the portfolio in one non-stable token that raises the concentration card, and makes it a warning. */
  readonly concentrationInfoPct: number;
  readonly concentrationWarningPct: number;
  /** The concentration card suggests swapping down to this share. */
  readonly concentrationTargetPct: number;
}

/** Owner decision of 13 Nov (DECISIONS.md): Balanced is the product's thresholds before presets. */
export const STRATEGIES: Readonly<Record<StrategyId, Strategy>> = {
  conservative: {
    label: 'Conservative',
    healthyAt: 1.8,
    targetHealthFactor: 2.0,
    warningBelow: 1.5,
    concentrationInfoPct: 50,
    concentrationWarningPct: 75,
    concentrationTargetPct: 40,
  },
  balanced: {
    label: 'Balanced',
    healthyAt: 1.5,
    targetHealthFactor: 1.6,
    warningBelow: 1.3,
    concentrationInfoPct: 60,
    concentrationWarningPct: 85,
    concentrationTargetPct: 50,
  },
  aggressive: {
    label: 'Aggressive',
    healthyAt: 1.25,
    targetHealthFactor: 1.35,
    warningBelow: 1.15,
    concentrationInfoPct: 75,
    concentrationWarningPct: 95,
    concentrationTargetPct: 65,
  },
};

/** For request bodies and query strings: missing means Balanced, an unknown name is an error. */
export const strategySchema = z.enum(STRATEGY_IDS).default(DEFAULT_STRATEGY);

/** For a URL param or cookie: anything that is not a preset name reads as Balanced. */
export const strategyOf = (value: unknown): StrategyId =>
  STRATEGY_IDS.find((id) => id === value) ?? DEFAULT_STRATEGY;

export const STRATEGY_COOKIE_PREFIX = 'np_strategy.';
