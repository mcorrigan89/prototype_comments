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
