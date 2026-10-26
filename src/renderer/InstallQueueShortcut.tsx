import { ui } from './i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { Download, Gamepad2 } from 'lucide-react';
import type { DownloadTask, Game } from '../shared/types';

export function previewTasks(downloads: readonly DownloadTask[]): DownloadTask[] {
  return [
    ...downloads.filter(task => task.status === 'running' || task.status === 'paused'),
    ...downloads.filter(task => task.status === 'queued').reverse(),
  ];
}

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  return `${Math.round(bytes / 1024)} KiB`;
}

function coverFor(task: DownloadTask, games: readonly Game[]): string | undefined {
  const game = games.find(game => game.id === task.gameId || game.storeId === task.productId);
  return task.coverUrl ?? game?.coverDataUrl ?? game?.coverUrl;
}

function Artwork({ cover }: { cover?: string }) {
  return <div className="queue-preview-art">{cover ? <img key={cover} src={cover} alt="" onError={event => { event.currentTarget.hidden = true; }} onLoad={event => { event.currentTarget.hidden = false; }} /> : null}<Gamepad2 aria-hidden="true" /></div>;
}

function Progress({ task }: { task: DownloadTask }) {
  const progress = task.progress !== null && Number.isFinite(task.progress) ? Math.max(0, Math.min(100, task.progress)) : undefined;
  const state = task.status === 'paused' ? ui("ui.paused_e159b06") : task.status === 'queued' ? ui("ui.queued_661ff40") : ui("ui.in_progress_c1f88e9");
  return <div className="queue-preview-progress"><div className={`progress-track ${progress === undefined && task.status === 'running' ? 'indeterminate' : ''}`}
    role="progressbar" aria-label={ui("ui.download_255860d", { name: task.title })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}
    aria-valuetext={progress === undefined ? state : ui('downloads.progress', { state, percent: Math.round(progress) })}>
    <i style={progress !== undefined ? { width: `${progress}%` } : task.status === 'running' ? undefined : { width: 0 }} /></div>
    <span>{progress === undefined ? state : `${Math.round(progress)}%`}</span></div>;
}

export function QueuePreview({ tasks, games }: { tasks: readonly DownloadTask[]; games: readonly Game[] }) {
  return <div className="queue-preview-card">
    <ul className="queue-preview-list">{tasks.map(task => {
      const current = Number.isFinite(task.downloadedBytes) && task.downloadedBytes! >= 0 ? task.downloadedBytes : undefined;
      const total = Number.isFinite(task.totalBytes) && task.totalBytes! > 0 ? task.totalBytes : undefined;
      return <li className={`queue-preview-item ${task.status}`} key={task.id}>
        <Artwork cover={coverFor(task, games)} />
        <div className="queue-preview-main"><strong title={task.title}>{task.title}</strong>
          <small>{total !== undefined ? `${current !== undefined ? size(current) : ui("ui.size_pending_aedf846")} / ${size(total)}`
            : current !== undefined ? ui("ui.downloaded_6d09ba2", { size: size(current) }) : task.status === 'queued' ? ui("ui.waiting_to_start_f5e5f81") : ui("ui.size_not_reported_yet_0686eec")}</small>
          <Progress task={task} />
          {task.status === 'paused' ? <small className="queue-preview-state">{ui("ui.paused_e159b06")}</small> : null}
        </div>
      </li>;
    })}</ul>
  </div>;
}

export function InstallQueueShortcut({ downloads, games, active, openQueue }: {
  downloads: readonly DownloadTask[]; games: readonly Game[]; active: boolean; openQueue: () => void;
}) {
  const tasks = previewTasks(downloads), [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null), panelId = useId();
  const visible = open && tasks.length > 0;
  const current = tasks[0];
  const state = current?.status === 'running' ? ui("ui.downloading_37b3455") : current?.status === 'paused' ? ui("ui.paused_e159b06") : ui("ui.queued_661ff40");
  const label = current ? ui('downloads.current', { state, current: 1, total: tasks.length }) : ui("ui.install_queue_128d2c9");
  const navigate = () => { setOpen(false); openQueue(); };
  useEffect(() => {
    if (!visible) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    const outside = (event: PointerEvent) => { if (!wrapper.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('keydown', escape); window.addEventListener('pointerdown', outside);
    return () => { window.removeEventListener('keydown', escape); window.removeEventListener('pointerdown', outside); };
  }, [visible]);
  return <div className="queue-shortcut" ref={wrapper}
    onPointerEnter={event => { if (event.pointerType !== 'touch') setOpen(true); }}
    onPointerLeave={() => { if (!wrapper.current?.contains(document.activeElement)) setOpen(false); }}
    onFocus={() => setOpen(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <button className={`queue-summary ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}
      aria-label={current ? ui('downloads.active_summary', { count: tasks.length, state, game: current.title }) : ui('ui.install_queue_128d2c9')}
      aria-expanded={tasks.length ? visible : undefined} aria-controls={visible ? panelId : undefined} onClick={navigate}>
      {current ? <Artwork cover={coverFor(current, games)} /> : <Download />}
      <div className="queue-summary-copy"><strong>{label}</strong>
        <small title={current?.title}>{current?.title ?? ui("ui.manage_installations_88e169c")}</small>
        {current ? <Progress task={current} /> : null}</div>
    </button>
    {visible ? <div className="queue-preview" id={panelId} role="region" aria-label={ui("ui.installation_progress_9b70263")}>
      <QueuePreview tasks={tasks} games={games} />
    </div> : null}
  </div>;
}
