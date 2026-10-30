const REPORT_INTERVAL_MS = 10_000;
const MAX_SIGNATURES = 512;

interface RepeatedLine {
  label: string;
  seen: number;
  suppressed: number;
  lastReportAt: number;
}

function verboseSignature(line: string): { key: string; label: string } | null {
  const match = line.match(/(?:^|:)(fixme|info|trace):([^:]+):(.+)$/i);
  if (!match) return null;
  const detail = match[3].replace(/\b(?:0x)?[0-9a-f]{8,}\b/gi, '<address>');
  const key = `${match[1].toLowerCase()}:${match[2].toLowerCase()}:${detail}`;
  return { key, label: key.slice(0, 120) };
}

export function gameLoggingEnvironment(source: NodeJS.ProcessEnv, verbose = false): NodeJS.ProcessEnv {
  const environment = { ...source };
  if (verbose) environment.XODUS_NEXUS_VERBOSE_LOGS = '1';
  if (environment.XODUS_NEXUS_VERBOSE_LOGS === '1') return environment;
  environment.WINEDEBUG ??= '-fixme';
  environment.VKD3D_DEBUG ??= 'warn';
  environment.VKD3D_SHADER_DEBUG ??= 'warn';
  return environment;
}

// A game is a separate desktop application. Do not pass Electron's startup
// notification or desktop-file identity through Xodus into Wine/Proton.
export function gameWindowEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of [
    'DESKTOP_STARTUP_ID', 'XDG_ACTIVATION_TOKEN', 'XDG_DESKTOP_FILE_NAME',
    'GIO_LAUNCHED_DESKTOP_FILE', 'GIO_LAUNCHED_DESKTOP_FILE_PID',
    'BAMF_DESKTOP_FILE_HINT', 'CHROME_DESKTOP', 'APPDIR', 'APPIMAGE', 'WINE_APPLICATION_ID',
  ]) delete environment[key];
  return environment;
}

export class GameLogReducer {
  private readonly repeated = new Map<string, RepeatedLine>();

  constructor(
    private readonly write: (line: string) => void,
    private readonly verbose = false,
    private readonly now: () => number = Date.now,
  ) {}

  push(line: string): void {
    const signature = this.verbose ? null : verboseSignature(line);
    if (!signature) {
      this.write(line);
      return;
    }
    let entry = this.repeated.get(signature.key);
    if (!entry) {
      if (this.repeated.size >= MAX_SIGNATURES) {
        this.write(line);
        return;
      }
      entry = { label: signature.label, seen: 0, suppressed: 0, lastReportAt: this.now() };
      this.repeated.set(signature.key, entry);
    }
    entry.seen += 1;
    if (entry.seen <= 2) {
      this.write(line);
      return;
    }
    entry.suppressed += 1;
    if (this.now() - entry.lastReportAt >= REPORT_INTERVAL_MS) this.report(entry);
  }

  flush(): void {
    for (const entry of this.repeated.values()) this.report(entry);
  }

  private report(entry: RepeatedLine): void {
    if (entry.suppressed === 0) return;
    this.write(`Suppressed ${entry.suppressed} repeated ${entry.label} diagnostic lines. Enable verbose logs in Settings or set XODUS_NEXUS_VERBOSE_LOGS=1 for full output.`);
    entry.suppressed = 0;
    entry.lastReportAt = this.now();
  }
}
