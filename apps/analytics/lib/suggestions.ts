import type { Fact } from '../components/primitives';
import { money } from './format';
import type { PortfolioAction } from './product';
import type { RecommendationIntent } from './recommendation-intent';

/** Where one suggestion card stands: open, waiting for the wallet, its receipt, or why it did not go through. */
export type CardStage =
  | { readonly kind: 'open' }
  | { readonly kind: 'signing'; readonly step: number; readonly of: number }
  | { readonly kind: 'done'; readonly hash?: string; readonly confirmed: boolean }
  | { readonly kind: 'failed'; readonly reason: string };

export interface SkippedMove {
  readonly title?: string;
  readonly number?: string;
  readonly reason: string;
}

const signed = (usd: number) => `${usd >= 0 ? '+' : ''}${money(usd, true)}`;

/** A demo's moves worth doing become cards; the rest are listed as checked and skipped, with their net and reason. */
export function splitDemo(actions: readonly PortfolioAction[]) {
  const cards = actions.filter((a) => a.autopilot.verdict === 'worth_it');
  const skipped: SkippedMove[] = actions
    .filter((a) => a.autopilot.verdict !== 'worth_it')
    .map((a) => ({
      title: a.title,
      ...(a.netUsd !== null && { number: `${signed(a.netUsd)} / ${a.horizonDays} d` }),
      reason: a.autopilot.sentence,
    }));
  return { cards, skipped };
}

export function demoFacts(a: PortfolioAction): Fact[] {
  const facts: Fact[] = [];
  if (a.netUsd !== null)
    facts.push({
      label: a.kind === 'keep' ? 'Saves' : 'Earns',
      value: signed(a.netUsd),
      sub: `/ ${a.horizonDays} days`,
      good: a.netUsd > 0,
    });
  if (a.netAprOnCapital !== null)
    facts.push({
      label: 'Rate',
      value: `${(a.netAprOnCapital * 100).toFixed(1)}%`,
      sub: 'a year after costs',
    });
  const cost = a.costs.reduce((s, c) => s + c.usd, 0);
  if (a.costs.length > 0)
    facts.push({
      label: 'Cost',
      value: `≈ ${money(cost, true)}`,
      sub: a.costs.map((c) => c.label).join(', '),
    });
  return facts;
}

/** A real account's facts: only numbers the intent already carries (structured facts from the API: #284). */
export function accountFacts(intent: RecommendationIntent | null): Fact[] {
  if (!intent || !('approxUsd' in intent)) return [];
  if ('sizing' in intent && intent.sizing) return [];
  return [{ label: 'Amount', value: `≈ ${money(intent.approxUsd)}` }];
}

/** The Lead-and-Detail Rule: the first sentence is the conclusion, the rest supports it. */
export function leadAndDetail(text: string): { lead: string; detail: string } {
  const end = text.search(/[.!?](\s|$)/);
  if (end < 0) return { lead: text, detail: '' };
  return { lead: text.slice(0, end + 1), detail: text.slice(end + 1).trim() };
}

/** The #1 card is the first one not yet done. */
export const topIndex = (stages: readonly CardStage['kind'][]) =>
  stages.findIndex((s) => s !== 'done');

/** `through`: steps that landed (confirmed or sent unchecked); `confirmed`: NEAR confirmed every one of them. */
export function stageAfterSign(
  r: { ok: boolean; hashes: readonly string[]; reason?: string },
  { confirmed, through, steps = through }: { confirmed: boolean; through: number; steps?: number },
): CardStage {
  if (r.ok)
    return {
      kind: 'done',
      ...(r.hashes.length > 0 && { hash: r.hashes[r.hashes.length - 1] }),
      confirmed,
    };
  const reason = r.reason ?? 'The transaction did not go through.';
  if (r.hashes.length === 0) return { kind: 'failed', reason };
  return {
    kind: 'failed',
    reason: `${through} of ${steps} steps went through. ${reason.replace(/\.?$/, '.')} Check NearBlocks before trying again.`,
  };
}

export interface Held<T> {
  readonly item: T;
  readonly index: number;
  readonly stage: CardStage;
  /** The card's progress sheet is open: nothing may move or remount it. */
  readonly sheet: boolean;
}

const sameCard = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Open sheet: always. Receipt: until the agents send a changed card with the same id. */
export function isHeld<T extends { id: string }>(
  h: Pick<Held<T>, 'item' | 'stage' | 'sheet'>,
  list: readonly T[],
): boolean {
  if (h.sheet) return true;
  if (h.stage.kind !== 'done') return false;
  const fresh = list.find((x) => x.id === h.item.id);
  return !fresh || sameCard(fresh, h.item);
}

/** Held cards keep the place and the snapshot they had when signing started; the others follow the list. */
export function withKept<T extends { id: string }>(
  list: readonly T[],
  kept: ReadonlyMap<string, Held<T>>,
): T[] {
  const held = [...kept.values()].filter((h) => isHeld(h, list)).sort((a, b) => a.index - b.index);
  const out = list.filter((x) => !held.some((h) => h.item.id === x.id));
  for (const { item, index } of held) out.splice(Math.min(index, out.length), 0, item);
  return out;
}
