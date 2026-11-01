import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { demoSnapshot } from '../shared/demo-data';
import { DiagnosticReportButton, DiagnosticReportDialog } from './DiagnosticReport';

describe('diagnostic report review', () => {
  it('offers optional game logs and an explicit export action', () => {
    const html = renderToStaticMarkup(<DiagnosticReportButton games={demoSnapshot().games} />);
    expect(html).toContain('Export report'); expect(html).toContain('No game logs');
    expect(html).toContain('Game logs for report'); expect(html).toContain(demoSnapshot().games[0].title);
  });
  it('renders editable escaped text with review notice, local save and B/close support', () => {
    const html = renderToStaticMarkup(<DiagnosticReportDialog report={{ name: 'report.txt', content: '<script>bad()</script>' }} close={() => {}} />);
    expect(html).toContain('<textarea'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('best effort'); expect(html).toContain('Nothing is uploaded automatically');
    expect(html).toContain('Save report'); expect(html).toContain('data-gamepad-cancel');
  });
});
