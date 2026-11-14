import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Button,
  Card,
  Chip,
  FactsStrip,
  LoanGauge,
  Panel,
  ProvenanceMark,
  Receipt,
  Segmented,
  SignButton,
  bufferPct,
} from '../components/primitives';

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

describe('Button', () => {
  it('is a secondary 36px button by default, never a submit', () => {
    expect(html(<Button>Go</Button>)).toBe(
      '<button type="button" class="ds-btn ds-btn-secondary">Go</button>',
    );
  });

  it('renders the primary, ghost and small variants', () => {
    expect(html(<Button variant="primary">A</Button>)).toContain('ds-btn ds-btn-primary');
    expect(
      html(
        <Button variant="ghost" size="sm">
          B
        </Button>,
      ),
    ).toContain('ds-btn ds-btn-ghost ds-btn-sm');
  });
});

describe('SignButton', () => {
  it('shows a pen when ready', () => {
    const out = html(<SignButton ready>Sign</SignButton>);
    expect(out).toContain('ds-btn ds-btn-sign');
    expect(out).toContain('data-icon="pen"');
    expect(out).not.toContain('disabled');
  });

  it('is disabled with a lock and a reason line it is described by', () => {
    const out = html(
      <SignButton ready={false} reason="Tick I understand above.">
        Sign
      </SignButton>,
    );
    expect(out).toContain('disabled=""');
    expect(out).toContain('data-icon="lock"');
    const id = /aria-describedby="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`id="${id}" class="ds-sign-reason">Tick I understand above.</p>`);
  });
});

describe('Chip', () => {
  it('is neutral without a tone', () => {
    expect(html(<Chip>Earning</Chip>)).toBe('<span class="ds-chip">Earning</span>');
  });

  it('takes a risk, AI or large tint', () => {
    for (const tone of ['safe', 'watch', 'act', 'liq', 'ai'] as const)
      expect(html(<Chip tone={tone}>x</Chip>)).toContain(`ds-chip ds-chip-${tone}`);
    expect(
      html(
        <Chip tone="liq" large>
          x
        </Chip>,
      ),
    ).toContain('ds-chip ds-chip-liq ds-chip-lg');
  });

  it('marks demo with a hatch', () => {
    expect(html(<Chip tone="demo">Demo</Chip>)).toBe(
      '<span class="ds-chip ds-chip-demo"><span class="ds-hatch" aria-hidden="true"></span>Demo</span>',
    );
  });
});

describe('ProvenanceMark', () => {
  it('draws a dot, ring or hatch and keeps the age', () => {
    expect(html(<ProvenanceMark kind="on_chain" age="12 s ago" />)).toBe(
      '<span class="ds-prov ds-prov-on_chain">On-chain · 12 s ago</span>',
    );
    expect(html(<ProvenanceMark kind="estimate">Heuristic</ProvenanceMark>)).toBe(
      '<span class="ds-prov ds-prov-estimate">Heuristic</span>',
    );
    expect(html(<ProvenanceMark kind="simulated" />)).toContain('ds-prov-simulated">Simulated');
  });
});

describe('Panel, Card, Receipt', () => {
  it('render their containers', () => {
    expect(html(<Panel label="Analysis">a</Panel>)).toBe(
      '<section class="ds-panel" aria-label="Analysis">a</section>',
    );
    expect(html(<Card>a</Card>)).toBe('<article class="ds-card">a</article>');
    expect(html(<Card top>a</Card>)).toContain('ds-card ds-card-top');
    expect(
      html(
        <Card top urgent>
          a
        </Card>,
      ),
    ).toContain('ds-card ds-card-top ds-card-act');
    expect(html(<Card urgent>a</Card>)).toContain('ds-card ds-card-act');
    expect(html(<Receipt>Done</Receipt>)).toBe('<div class="ds-receipt">Done</div>');
  });
});

describe('FactsStrip', () => {
  it('is a definition list; gains are marked', () => {
    expect(
      html(
        <FactsStrip
          items={[
            { label: 'Earns', value: '$2.78', sub: 'a month', good: true },
            { label: 'Fee', value: '0.01 NEAR' },
          ]}
        />,
      ),
    ).toBe(
      '<dl class="ds-facts"><div><dt>Earns</dt><dd class="good">$2.78 <small>a month</small></dd></div>' +
        '<div><dt>Fee</dt><dd>0.01 NEAR</dd></div></dl>',
    );
  });
});

describe('LoanGauge', () => {
  it('turns a health factor into how far collateral may fall', () => {
    expect(bufferPct(2)).toBe(50);
    expect(bufferPct(1)).toBe(0);
    expect(bufferPct(0.8)).toBe(0);
  });

  it('places zones and the knob on a 0–60% buffer axis and says the sentence', () => {
    const out = html(<LoanGauge healthFactor={1.25} urgentBelow={1.3} safeFrom={1.5} />);
    expect(out).toContain(
      'role="img" aria-label="Loan buffer 20%: urgent below 23%, safe from 33%"',
    );
    expect(out).toContain('class="ds-gauge-you" style="left:33.3%"');
    expect(out).toContain('<em>urgent 23%</em>');
    expect(out).toContain('Liquidation if your collateral falls <b>20%</b>.');
  });

  it('says a loan at or below 1 can be liquidated now', () => {
    expect(html(<LoanGauge healthFactor={0.95} urgentBelow={1.3} safeFrom={1.5} />)).toContain(
      'The loan can be liquidated now.',
    );
  });

  it('keeps the knob on the track for a very safe loan', () => {
    expect(html(<LoanGauge healthFactor={10} urgentBelow={1.3} safeFrom={1.5} />)).toContain(
      'class="ds-gauge-you" style="left:100%"',
    );
  });
});

describe('Segmented', () => {
  it('is a fieldset of native radios with the current one checked', () => {
    const out = html(
      <Segmented
        legend="Strategy"
        name="strategy"
        value="b"
        onChange={() => {}}
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ]}
      />,
    );
    expect(out).toContain('<fieldset class="ds-seg"><legend class="sr-only">Strategy</legend>');
    expect(out).toContain('<input type="radio" name="strategy" value="a"/>A');
    expect(out).toContain('<input type="radio" name="strategy" checked="" value="b"/>B');
  });
});
