import { expect, it } from 'vitest';
import { launchErrorPage } from './launch-error-page.js';

it('shows the refusal as text only, closable by key, click or controller', () => {
  const page = launchErrorPage('Unable to launch game', 'Offline <script>alert(1)</script> & "x"', 'OK');
  expect(page).toContain('Offline &#60;script&#62;alert(1)&#60;/script&#62; &#38; &#34;x&#34;');
  expect(page.match(/<script>/g)).toHaveLength(1);
  expect(page).toContain("default-src 'none'");
  expect(page).toContain('getGamepads');
});
