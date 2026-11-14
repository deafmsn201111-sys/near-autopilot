import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CheckedAndSkipped, NothingToDo, SuggestionCard } from '../components/SuggestionCard';

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

const base = {
  agent: 'Capital Allocator',
  logos: [],
  title: 'Lend idle USDt on Burrow',
  why: 'USDt in the wallet earns nothing. Supplying it earns the rate.',
  facts: [{ label: 'Earns', value: '+$4.20', sub: '/ 30 days', good: true }],
  tags: <span>tag</span>,
  actions: <button type="button">Lend</button>,
};

describe('SuggestionCard', () => {
  it('raises the top card and marks it #1 · AI pick only when the AI ranked it', () => {
    const ai = html(<SuggestionCard {...base} top aiPick stage={{ kind: 'open' }} />);
    expect(ai).toContain('ds-card-top');
    expect(ai).toContain('#1 · AI pick');
    const plain = html(<SuggestionCard {...base} top stage={{ kind: 'open' }} />);
    expect(plain).toContain('>#1<');
    expect(plain).not.toContain('AI pick');
    const second = html(<SuggestionCard {...base} stage={{ kind: 'open' }} />);
    expect(second).not.toContain('ds-card-top');
    expect(second).not.toContain('#1');
  });

  it('says how urgent it is with a severity chip and the act border', () => {
    const urgent = html(<SuggestionCard {...base} urgent stage={{ kind: 'open' }} />);
    expect(urgent).toContain('ds-card-act');
    expect(urgent).toContain('Act now');
    expect(html(<SuggestionCard {...base} stage={{ kind: 'open' }} />)).toContain('Worth doing');
  });

  it('shows the agent, facts, lead-and-detail explanation, tags and actions when open', () => {
    const out = html(<SuggestionCard {...base} stage={{ kind: 'open' }} />);
    expect(out).toContain('Capital Allocator');
    expect(out).toContain('ds-facts');
    expect(out).toContain('<b>USDt in the wallet earns nothing.</b> Supplying it earns the rate.');
    expect(out).toContain('>tag<');
    expect(out).toContain('>Lend<');
  });

  it('shows the wallet step while signing and keeps the actions mounted', () => {
    const out = html(<SuggestionCard {...base} stage={{ kind: 'signing', step: 1, of: 2 }} />);
    expect(out).toContain('sg-working');
    expect(out).toContain('Waiting for your wallet · step 1 of 2');
    expect(out).toContain('>Lend<');
  });

  it('replaces the body with a receipt and its tx link once done', () => {
    const out = html(
      <SuggestionCard
        {...base}
        top
        stage={{ kind: 'done', hash: '7QmPabcdefghk2Xa', confirmed: true }}
      />,
    );
    expect(out).toContain('ds-receipt');
    expect(out).toContain('Done just now.');
    expect(out).toContain('href="https://nearblocks.io/txns/7QmPabcdefghk2Xa"');
    expect(out).not.toContain('ds-facts');
    expect(out).not.toContain('ds-card-top');
    expect(out).toContain('Confirmed on NEAR');
  });

  it('does not claim a confirmation the server could not check', () => {
    const out = html(
      <SuggestionCard {...base} stage={{ kind: 'done', hash: 'abc', confirmed: false }} />,
    );
    expect(out).not.toContain('Confirmed on NEAR');
    expect(out).toContain('Sent; not checked here');
  });

  it('keeps the actions mounted but out of view once done, so an open sheet survives', () => {
    const out = html(<SuggestionCard {...base} stage={{ kind: 'done', confirmed: true }} />);
    expect(out).toContain('class="sg-hold"');
    expect(out).toContain('>Lend<');
  });

  it('says why it failed and keeps the actions to review again', () => {
    const out = html(
      <SuggestionCard {...base} stage={{ kind: 'failed', reason: 'declined in the wallet' }} />,
    );
    expect(out).toContain('Not done');
    expect(out).toContain('declined in the wallet');
    expect(out).toContain('>Lend<');
  });
});

describe('CheckedAndSkipped', () => {
  it('lists every skipped move with its number and reason behind a disclosure', () => {
    const out = html(
      <CheckedAndSkipped
        items={[
          { title: 'Lend idle NEAR', number: '+$0.15 / 30 d', reason: 'Below the $0.50 minimum.' },
          { reason: 'Too small to rebalance.' },
        ]}
      />,
    );
    expect(out).toContain('<details');
    expect(out).toContain('Checked and skipped');
    expect(out).toContain('2 moves');
    expect(out).toContain('+$0.15 / 30 d');
    expect(out).toContain('Too small to rebalance.');
  });

  it('keeps two skipped moves with the same reason', () => {
    const out = html(<CheckedAndSkipped items={[{ reason: 'Same.' }, { reason: 'Same.' }]} />);
    expect(out.match(/Same\./g)).toHaveLength(2);
  });

  it('renders nothing when nothing was skipped', () => {
    expect(html(<CheckedAndSkipped items={[]} />)).toBe('');
  });
});

describe('NothingToDo', () => {
  it('leads with the conclusion and gives the reasoning', () => {
    const out = html(<NothingToDo why="Every check passed." />);
    expect(out).toContain('Nothing to do right now.');
    expect(out).toContain('Every check passed.');
  });
});
