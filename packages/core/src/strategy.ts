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
  /** Where idle money may go (DECISIONS.md, #132): Aggressive alone weighs a same-asset loop against plain supply. */
  readonly idle: { readonly weighsLoop: boolean; readonly rule: string };
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
    idle: {
      weighsLoop: false,
      rule: 'plain lending only, no leverage and no impermanent loss',
    },
  },
  balanced: {
    label: 'Balanced',
    healthyAt: 1.5,
    targetHealthFactor: 1.6,
    warningBelow: 1.3,
    concentrationInfoPct: 60,
    concentrationWarningPct: 85,
    concentrationTargetPct: 50,
    // ponytail: no stablecoin pair is in the collector's pools; once one is, Balanced compares its net APR here
    idle: {
      weighsLoop: false,
      rule: 'a stablecoin pool would need to pay clearly more, and none is tracked yet',
    },
  },
  aggressive: {
    label: 'Aggressive',
    healthyAt: 1.25,
    targetHealthFactor: 1.35,
    warningBelow: 1.15,
    concentrationInfoPct: 75,
    concentrationWarningPct: 95,
    concentrationTargetPct: 65,
    idle: { weighsLoop: true, rule: 'highest yield, leverage included' },
  },
};

/** For request bodies and query strings: missing means Balanced, an unknown name is an error. */
export const strategySchema = z.enum(STRATEGY_IDS).default(DEFAULT_STRATEGY);

/** For a URL param or cookie: anything that is not a preset name reads as Balanced. */
export const strategyOf = (value: unknown): StrategyId =>
  STRATEGY_IDS.find((id) => id === value) ?? DEFAULT_STRATEGY;

export const STRATEGY_COOKIE = 'np_strategy';
const REMEMBERED_ACCOUNTS = 20;

type Remembered = [account: string, strategy: StrategyId][];

const remembered = (cookie: string | undefined): Remembered => {
  try {
    const parsed: unknown = JSON.parse(cookie ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is Remembered[number] =>
        Array.isArray(e) && typeof e[0] === 'string' && STRATEGY_IDS.includes(e[1] as StrategyId),
    );
  } catch {
    return [];
  }
};

/** The last strategy chosen for this account, from the one cookie that holds the most recent accounts. */
export const savedStrategy = (cookie: string | undefined, account: string) =>
  remembered(cookie).find(([a]) => a === account)?.[1];

/** The cookie value with this choice as the most recent; the oldest accounts drop off past the limit. */
export const rememberStrategy = (
  cookie: string | undefined,
  account: string,
  strategy: StrategyId,
): string =>
  JSON.stringify(
    [...remembered(cookie).filter(([a]) => a !== account), [account, strategy]].slice(
      -REMEMBERED_ACCOUNTS,
    ),
  );
