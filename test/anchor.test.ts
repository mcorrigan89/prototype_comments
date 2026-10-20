import { beforeEach, describe, expect, it } from 'vitest';
import { buildSelector, makePin, resolveElement } from '../src/anchor';

beforeEach(() => {
  document.body.innerHTML = `
    <main>
      <section><button>One</button><button>Two</button></section>
      <section id="r1234-generated"><p>Hello</p></section>
      <div id="promo"><span>Sale</span></div>
      <button data-pc-anchor="cta">Buy now</button>
      <div data-testid="card"><h3>Card</h3></div>
    </main>`;
});

describe('buildSelector', () => {
  it('builds an nth-of-type path from body', () => {
    const second = document.querySelectorAll('button')[1];
    const selector = buildSelector(second);
    expect(selector).toBe('body > main:nth-of-type(1) > section:nth-of-type(1) > button:nth-of-type(2)');
    expect(document.querySelector(selector)).toBe(second);
  });

  it('prefers data-pc-anchor, data-testid and stable ids', () => {
    expect(buildSelector(document.querySelector('[data-pc-anchor]')!)).toBe('[data-pc-anchor="cta"]');
    expect(buildSelector(document.querySelector('h3')!)).toBe('[data-testid="card"] > h3:nth-of-type(1)');
    expect(buildSelector(document.querySelector('#promo span')!)).toBe('#promo > span:nth-of-type(1)');
  });

  it('skips ids that look generated', () => {
    expect(buildSelector(document.querySelector('p')!)).not.toContain('#r1234');
  });
});

describe('resolveElement', () => {
  it('finds the element by selector', () => {
    const el = document.querySelectorAll('button')[1];
    expect(resolveElement(makePin(el, 0, 0))).toBe(el);
  });

  it('falls back to matching text when the layout changes', () => {
    const el = document.querySelectorAll('button')[1];
    const pin = makePin(el, 0, 0);
    // A new button inserted before it shifts every nth-of-type index.
    el.parentElement!.prepend(Object.assign(document.createElement('button'), { textContent: 'Zero' }));
    expect(document.querySelector(pin.selector)?.textContent).toBe('One');
    expect(resolveElement(pin)).toBe(el);
  });

  it('returns null when the element is gone and its text is ambiguous or missing', () => {
    const el = document.querySelectorAll('button')[1];
    const pin = makePin(el, 0, 0);
    el.remove();
    expect(resolveElement({ ...pin, selector: 'nav > a' })).toBeNull();
  });
});
