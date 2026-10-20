import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config';

function tag(attrs: Record<string, string>) {
  const script = document.createElement('script');
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
  return script;
}

describe('readConfig', () => {
  it('uses Notion storage when the tag names a feedback database', () => {
    const config = readConfig({}, tag({ 'data-notion': 'https://www.notion.so/acme/Checkout-Feedback-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d?v=99', 'data-endpoint': 'https://api.test' }));
    expect(config).toMatchObject({
      storage: 'remote',
      project: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
      notion: 'https://www.notion.so/acme/Checkout-Feedback-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d?v=99',
      endpoint: 'https://api.test',
    });
  });

  it('stays local without one', () => {
    expect(readConfig({}, tag({ 'data-project': 'p' }))).toMatchObject({ storage: 'local', project: 'p' });
  });
});

describe('findScriptTag', () => {
  it('finds a module-loaded tag (no currentScript) by data-notion alone', async () => {
    const { findScriptTag } = await import('../src/config');
    const script = tag({ type: 'module', 'data-notion': 'demo-shop' });
    document.head.append(script);
    expect(findScriptTag()).toBe(script);
    script.remove();
  });
});

describe('notionIdFrom', () => {
  it('reads ids from every Notion link format', async () => {
    const { notionIdFrom } = await import('../src/util');
    const id = '3ff97c7e2fc18018a96bcdb995ef3416';
    expect(notionIdFrom(`https://app.notion.com/p/govwell/Prototype-Feedback-Kite-${id}?source=copy_link`)).toBe(id);
    expect(notionIdFrom(`https://www.notion.so/govwell/Feedback-${id}?v=0123456789abcdef0123456789abcdef`)).toBe(id);
    expect(notionIdFrom('3ff97c7e-2fc1-8018-a96b-cdb995ef3416')).toBe(id);
    expect(notionIdFrom('demo-shop')).toBeNull();
  });
});
