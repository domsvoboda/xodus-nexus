import { ui, uiText } from './i18n';
import { useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import type { DiagnosticReport, Game } from '../shared/types';

export function DiagnosticReportDialog({ report, close }: { report: DiagnosticReport; close: () => void }) {
  const [content, setContent] = useState(report.content);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  async function save() {
    setSaving(true); setMessage('');
    try { if (await window.launcher.saveDiagnosticReport(content)) setMessage(ui("ui.report_saved_attach_the_text_file_to_your_issue_3c3a3c9")); }
    catch { setMessage(ui("ui.could_not_save_the_report_choose_a_new_txt_filen_e13620a")); }
    finally { setSaving(false); }
  }
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) close(); }}>
    <section className="game-dialog diagnostic-dialog" role="dialog" aria-modal="true" aria-label={ui("ui.review_diagnostic_report_5df3e77")}>
      <h2>{ui("ui.review_diagnostic_report_5df3e77")}</h2>
      <p>{ui("ui.automatic_redaction_is_best_effort_review_and_re_a4f3856")}</p>
      <label className="diagnostic-report-editor">{ui("ui.report_contents_0c465ee")}<textarea value={content} onChange={event => setContent(event.target.value)} spellCheck={false} /></label>
      {message ? <p role="status">{uiText(message)}</p> : null}
      <div className="dialog-actions"><button className="secondary" disabled={saving || !content.trim()} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" /> : <Download />}{ui("ui.save_report_8ec314b")}</button><button className="secondary" disabled={saving} data-gamepad-cancel onClick={close}>{ui("ui.close_7d9eb7a")}</button></div>
    </section>
  </div>;
}

export function DiagnosticReportButton({ games }: { games: Game[] }) {
  const [gameId, setGameId] = useState('');
  const [report, setReport] = useState<DiagnosticReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function create() {
    setLoading(true); setError('');
    try { setReport(await window.launcher.createDiagnosticReport(gameId || undefined)); }
    catch { setError(ui("ui.could_not_create_the_report_check_that_the_selec_a26ca38")); }
    finally { setLoading(false); }
  }
  return <section>
    <h3>{ui("ui.diagnostic_report_abb39b8")}</h3><p className="fine-print">{ui("ui.versions_system_information_backend_and_recent_d_49311e0")}</p>
    <div className="button-row"><select aria-label={ui("ui.game_logs_for_report_2a690ff")} value={gameId} disabled={loading} onChange={event => setGameId(event.target.value)}><option value="">{ui("ui.no_game_logs_17cede8")}</option>{games.map(game => <option key={game.id} value={game.id}>{game.title}</option>)}</select><button className="secondary" disabled={loading} onClick={() => void create()}>{loading ? <LoaderCircle className="spin" /> : <Download />}{ui("ui.export_diagnostic_report_f984fba")}</button></div>
    {error ? <p role="alert">{uiText(error)}</p> : null}
    {report ? <DiagnosticReportDialog report={report} close={() => setReport(undefined)} /> : null}
  </section>;
}
