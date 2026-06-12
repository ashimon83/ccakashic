import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../src/util';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters including quotes', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;'
    );
  });

  it('coerces non-strings', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(null)).toBe('null');
  });
});
