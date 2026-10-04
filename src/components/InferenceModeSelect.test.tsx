import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { InferenceModeSelect } from './InferenceModeSelect';

describe('inference output permission', () => {
 it.each([true, false])('disabled permission hides selector even when stored unified=%s', unified => {
  const html=renderToStaticMarkup(<InferenceModeSelect enabled={false} unified={unified} onChange={vi.fn()} />);
  expect(html).toContain('同源');expect(html).not.toContain('双模');expect(html).not.toContain('<select');expect(html).not.toContain('<option');
 });
 it('enabled permission exposes both modes', () => {
  const html=renderToStaticMarkup(<InferenceModeSelect enabled unified={false} onChange={vi.fn()} />);
  expect(html).toContain('双模');expect(html).toContain('同源');expect(html).toContain('<select');
 });
});
