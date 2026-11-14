import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
}));

const { AnalysisPanel } = await import('../components/AnalysisPanel');

const panel = (props: Partial<Parameters<typeof AnalysisPanel>[0]>) =>
  renderToStaticMarkup(
    <AnalysisPanel
      account="alice.near"
      strategy="balanced"
      recommendations={[]}
      rules={[]}
      skipped={[]}
      analysis={null}
      live={null}
      startedAt={null}
      ranAt={null}
      aiAllowed
      hasLoan={false}
      loanValued
      hasLp={false}
      portfolioChanged={false}
      error={null}
      onRun={() => undefined}
      {...props}
    />,
  );

describe('analysis panel after a failed AI run', () => {
  it('says what happened in plain words, that rules are shown, and offers a retry', () => {
    const out = panel({ error: { error: 'the analytics service is unreachable', status: 0 } });
    expect(out).toContain('class="an-fail"');
    expect(out).toContain('The AI could not be reached.');
    expect(out).toContain('rule-based result');
    expect(out).toContain('Try again');
    expect(out).not.toContain('analytics service');
    expect(out).toContain('What the agents found');
  });

  it('a run the API ended as busy is the same designed state, not a bare note', () => {
    const out = panel({
      analysis: {
        source: 'rules',
        fallback: 'busy',
        note: 'AI analysis is busy right now; showing the rule-based list. Try again in a few minutes.',
        recommendations: [],
        trace: [],
      } as never,
    });
    expect(out).toContain('The AI is busy right now.');
    expect(out).not.toContain('class="an-note"');
  });

  it('a run that did not fail shows no failure', () => {
    expect(panel({})).not.toContain('an-fail');
  });
});
