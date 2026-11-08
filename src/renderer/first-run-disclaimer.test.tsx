import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { demoSnapshot } from '../shared/demo-data';
import { FirstRunWizard } from './App';

it('shows the upstream distinction and Nexus-only reporting before setup and sign-in', () => {
  const html = renderToStaticMarkup(<FirstRunWizard data={demoSnapshot()} toast={() => {}} />);
  const notice = html.match(/<section class="wizard-disclaimer"[^>]*>[\s\S]*?<\/section>/)?.[0];
  expect(notice).toContain('role="note"');
  expect(notice).toContain('Independent, unofficial project');
  expect(notice).toContain('not an official Xodus project');
  expect(notice).toContain('not developed or maintained by the upstream Xodus developers');
  expect(notice).toContain('https://github.com/domsvoboda/nexus-launcher/issues');
  expect(notice).toContain('target="_blank" rel="noopener noreferrer"');
  expect(notice).toContain('A problem in Nexus Launcher may not exist in upstream Xodus.');
  expect(html.indexOf('wizard-disclaimer')).toBeLessThan(html.indexOf('Games folder'));
  expect(html).toMatch(/<input[^>]*data-gamepad-initial/);
  expect(html).toContain('Start using Nexus Launcher');
});
