import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GameLanguage } from './GameLanguage';

it.each([{ locales: [] }, { locales: ['en'] }, { locales: ['en', 'pl-PL', 'de'] }])('offers generic overrides even with incomplete package hints $locales', ({ locales }) => {
  const html = renderToStaticMarkup(<GameLanguage locales={locales} value="pl-PL" onChange={() => {}} />);
  expect(html).toContain('System default');
  expect(html).toContain('Language overrides (support varies)');
  expect(html).toContain('Polish (Poland) (pl-PL)');
  expect(html).toContain('do not install translations or voice packs');
  expect(html.match(/value="pl-PL"/g)).toHaveLength(1);
  expect(html).toContain('value="pt-PT"'); expect(html).toContain('value="pt-BR"');
});

it('preserves saved custom selections and escapes untrusted resource text', () => {
  const html = renderToStaticMarkup(<GameLanguage locales={['en']} value="sr-Latn-RS" onChange={() => {}} />);
  expect(html).toContain('value="sr-Latn-RS" selected');
  const unsafe = renderToStaticMarkup(<GameLanguage locales={['<script>']} value="" onChange={() => {}} />);
  expect(unsafe).not.toContain('<script>');
});
