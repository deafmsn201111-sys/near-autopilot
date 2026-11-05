import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allDefended, FIXTURE_LABEL, runAttacks } from '../src/demo/attack';
import { attackPolicy, LOG_FILE, toLog } from '../src/demo/attack-main';
import { replayVerdict } from '../src/evidence/replay';

describe('demo:attack (fixtures against the real defences)', () => {
  it('stops every attack at the defence meant for it, lets both controls through, signs and sends nothing', async () => {
    const { entries } = await runAttacks(attackPolicy());
    expect(allDefended(entries)).toBe(true);
    expect(entries.every((e) => e.fixture && e.label === FIXTURE_LABEL)).toBe(true);
    const by = Object.fromEntries(entries.map((e) => [e.attack, e]));
    expect(by['control-repay']).toMatchObject({ outcome: 'ALLOWED', verdict: 'ALLOW' });
    expect(by['control-swap']).toMatchObject({ outcome: 'ALLOWED', verdict: 'ALLOW' });
    expect(by['prompt-injection-transfer']).toMatchObject({
      outcome: 'DISCARDED',
      failed: ['FORBIDDEN_FIELD', 'SCHEMA'],
    });
    expect(by['prompt-injection-impersonation']).toMatchObject({
      outcome: 'DISCARDED',
      failed: ['WRONG_AGENT'],
    });
    // Exactly one check fails for each policy attack: the one it targets.
    expect(by['foreign-recipient']).toMatchObject({ verdict: 'BLOCK', failed: ['action_shape'] });
    expect(by['extra-withdraw']).toMatchObject({ verdict: 'BLOCK', failed: ['intent_match'] });
    expect(by['stale-price']).toMatchObject({ verdict: 'BLOCK', failed: ['price_freshness'] });
    expect(by['thin-pool']).toMatchObject({ verdict: 'BLOCK', failed: ['oracle_deviation'] });
    expect(by['forged-approval']).toMatchObject({ outcome: 'REFUSED', failed: ['refused'] });
    expect(by['forged-approval']?.reasons).toEqual([
      'Approval was not issued by the policy engine',
    ]);
    expect(by['full-access-key']).toMatchObject({
      outcome: 'REFUSED',
      failed: ['FULL_ACCESS_KEY_REFUSED'],
      signed: 0,
      broadcast: 0,
    });
  });

  it('the committed log is exactly what a run produces (deterministic, not hand-edited)', async () => {
    const { entries } = await runAttacks(attackPolicy());
    expect(readFileSync(LOG_FILE, 'utf8')).toBe(toLog(entries));
  });

  it('every attack verdict replays to the same verdict from its stored row', async () => {
    const { verdicts } = await runAttacks(attackPolicy());
    expect(verdicts.map((v) => v.verdict)).toEqual([
      'ALLOW',
      'ALLOW',
      'BLOCK',
      'BLOCK',
      'BLOCK',
      'BLOCK',
    ]);
    for (const v of verdicts) {
      const row = {
        ...v,
        valueUsdMicro: v.valueUsdMicro === null ? null : v.valueUsdMicro.toString(),
        checks: JSON.parse(JSON.stringify(v.checks)) as unknown,
        violations: JSON.parse(JSON.stringify(v.violations)) as unknown,
        input: JSON.parse(JSON.stringify(v.input)) as unknown,
      };
      expect(replayVerdict(row)).toMatchObject({ status: 'match', verdict: v.verdict });
    }
  });
});
