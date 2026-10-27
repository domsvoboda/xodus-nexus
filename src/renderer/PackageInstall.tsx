import { ContentList } from './ContentSelection';
import { ui, uiText } from './i18n';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CatalogProduct, GameContentPlan, InstallPlan, InstallRequest } from '../shared/types';
import { estimatedInstallBytes, installByteLabel } from '../shared/install-storage';

export function catalogInstallRequest(product: Pick<CatalogProduct, 'productId' | 'installProductId' | 'title'>, destination: string): InstallRequest {
  return { productId: product.productId, title: product.title, destination };
}

type Install = (request: InstallRequest) => Promise<string | undefined>;
const InstallContext = createContext<Install>(async () => { throw Error("Installation dialog is unavailable."); });
export const usePackageInstall = () => useContext(InstallContext);

export async function confirmedPackageInstall(request: InstallRequest,
  api: Pick<Window['launcher'], 'getInstallPlan' | 'startInstall'>,
  confirm: (plan: InstallPlan) => Promise<string | undefined>, mounted: () => boolean,
  selectContent?: (choice: InstallPlan['choices'][number]) => Promise<string[] | undefined>): Promise<string | undefined> {
  const result = await api.getInstallPlan(request.productId, request.destination);
  if (!mounted()) return;
  if (result.status === 'unavailable') throw Error("No supported Windows.Desktop MSIXVC package was found for this Store offer.");
  const selected = await confirm(result);
  if (!selected || !mounted()) return;
  const choice = result.choices.find(choice => choice.supported && choice.contentId === selected);
  if (!choice) throw Error('Invalid installation package selection.');
  if (selectContent && choice.kind === 'Game') {
    const ids = await selectContent(choice); if (!ids || !mounted()) return;
    return api.startInstall({ ...request, selectedContentId: selected, selectionMarket: result.market, contentProductIds: ids });
  }
  return api.startInstall({ ...request, selectedContentId: selected, selectionMarket: result.market });
}

export function InstallContentDialog({ plan, choose, error }: { plan: GameContentPlan; choose: (ids?: string[]) => void; error?: string }) {
  const [selected, setSelected] = useState(plan.runtimeSupported === false ? [] : plan.items.filter(item => item.access && item.status === 'available').map(item => item.productId));
  useEffect(() => { const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') choose(); }; window.addEventListener('keydown', cancel); return () => window.removeEventListener('keydown', cancel); }, [choose]);
  return <div className="dialog-backdrop"><section className="game-dialog content-dialog" role="dialog" aria-modal="true" aria-label={ui('dlc.install_game_title')}>
    <h2>{ui('dlc.install_game_title')}</h2>{error ? <p role="alert" className="error-text">{ui('dlc.preflight_failed')}</p> : <p>{ui('dlc.preflight_message')}</p>}
    {plan.runtimeSupported === false ? <p className="error-text">{ui('ui.update_the_nexus_runtime_in_settings_before_inst_ace6eca')}</p> : null}
    {!error ? <ContentList plan={plan} disabled={plan.runtimeSupported === false} selected={selected} change={setSelected} /> : null}
    <div className="dialog-actions"><button className="secondary" data-gamepad-cancel onClick={() => choose()}>{ui('ui.cancel_19766ed')}</button><button className="primary" onClick={() => choose(selected)}>{selected.length ? ui('dlc.install_selected', { count: selected.length }) : ui('dlc.install_base')}</button></div>
  </section></div>;
}

export function PackageDialog({ plan, choose, destination }: { plan: InstallPlan; choose: (id?: string) => void; destination?: string }) {
  const [selected, setSelected] = useState(() => plan.status === 'ready' ? plan.choices.find(item => item.supported)?.contentId ?? '' : '');
  const choice = plan.choices.find(item => item.contentId === selected);
  const estimated = estimatedInstallBytes(choice);
  const lowSpace = estimated !== undefined && plan.availableBytes !== undefined && estimated > plan.availableBytes;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') choose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [choose]);
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) choose(); }}>
    <section className="game-dialog package-dialog" role="dialog" aria-modal="true" aria-labelledby="package-dialog-title">
      <h2 id="package-dialog-title">{plan.status === 'ready' ? ui("ui.install_game_675299c") : ui("ui.choose_files_to_install_4a6019d")}</h2>
      <p>{plan.status === 'ready' ? ui("ui.review_the_installation_before_downloading_708b238") : ui("ui.choose_the_package_you_want_to_install_from_this_82f3bef")}{' '}{ui("ui.xodus_checks_your_license_before_downloading_ca2f356")}</p>
      <div className="package-choices">{plan.choices.map(item => <label className={`package-choice${item.supported ? '' : ' unsupported'}`} key={`${item.productId}:${item.contentId}`}>
        <input type="radio" name="install-package" value={item.contentId} disabled={!item.supported} checked={selected === item.contentId} onChange={() => setSelected(item.contentId)} />
        <span><strong>{item.title}</strong><small>{item.platform || ui("ui.unknown_platform_9e67415")} · {item.packageFormat || ui("ui.unknown_format_b85b102")}{['GameAddOn', 'Durable'].includes(item.kind) ? ui("ui.add_on_a0e4463") : ''}{!item.supported ? ui("ui.unsupported_7f34e93") : ''}</small><small>{ui('package.estimate', { size: uiText(installByteLabel(item.downloadBytes)) })}</small><small>{ui('store.id', { id: item.productId })}</small></span>
      </label>)}</div>
      <div className="install-storage" aria-label={ui("ui.installation_storage_3b5f20c")}>
        {destination ? <p className="install-destination" title={destination}>{destination}</p> : null}
        <dl><div><dt>{ui("ui.estimated_space_040a03c")}</dt><dd>{uiText(installByteLabel(estimated))}</dd></div><div><dt>{ui("ui.available_on_target_drive_6208a3b")}</dt><dd>{uiText(installByteLabel(plan.availableBytes))}</dd></div></dl>
        {lowSpace ? <p className="warning-text" role="status">{ui("ui.the_estimate_exceeds_available_space_existing_fi_6888550")}</p> : <small>{ui("ui.sizes_are_estimates_the_downloader_checks_actual_b6e47d1")}</small>}
      </div>
      <div className="dialog-actions"><button className="secondary" data-gamepad-cancel onClick={() => choose()}>{ui("ui.cancel_19766ed")}</button><button className="primary" disabled={!selected} onClick={() => choose(selected)}>{plan.status === 'ready' ? ui("ui.install_569ca49") : ui("ui.install_selected_package_6cb94e6")}</button></div>
    </section>
  </div>;
}

export function PackageInstallProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<{plan: InstallPlan; destination: string}>();
  const pending = useRef<((id?: string) => void)>();
  const [content, setContent] = useState<GameContentPlan>();
  const [contentError, setContentError] = useState<string>();
  const pendingContent = useRef<((ids?: string[]) => void)>();
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.(); pendingContent.current?.(); }; }, []);
  function choose(id?: string) { pending.current?.(id); pending.current = undefined; setDialog(undefined); }
  const install: Install = async request => {
    if (busy.current) throw Error("Finish the current package selection first.");
    busy.current = true;
    try {
      return await confirmedPackageInstall(request, window.launcher,
        result => new Promise<string | undefined>(resolve => { pending.current = resolve; setDialog({plan: result, destination: request.destination}); }),
        () => mounted.current, async choice => {
          let failure: string | undefined;
          setContentError(undefined);
          const plan = await window.launcher.getInstallContent(choice.productId, request.productId).catch(error => {
            failure = error instanceof Error ? error.message : String(error);
            return { gameId: choice.productId, checkedAt: '', items: [] } as GameContentPlan;
          });
          if (!mounted.current) return;
          if (!failure && !plan.items.some(item => item.access && item.status === 'available' || item.status === 'verify')) return [];
          setContentError(failure);
          return new Promise<string[] | undefined>(resolve => { pendingContent.current = resolve; setContent(plan); });
        });
    } finally { busy.current = false; }
  };
  return <InstallContext.Provider value={install}>{children}{dialog ? <PackageDialog plan={dialog.plan} destination={dialog.destination} choose={choose} /> : null}{content ? <InstallContentDialog plan={content} error={contentError} choose={ids => { pendingContent.current?.(ids); pendingContent.current = undefined; setContent(undefined); }} /> : null}</InstallContext.Provider>;
}
