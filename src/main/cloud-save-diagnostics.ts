export type CloudSaveProblem = 'conflict' | 'unavailable' | 'upload';

export const cloudSaveMessages: Record<CloudSaveProblem, string> = {
  conflict: 'Local and cloud saves conflict. Cloud sync is paused to protect your progress. Keep your local saves; this runtime did not offer a save-selection dialog.',
  unavailable: 'Cloud sync is unavailable for this session. Progress may only be saved on this device. Keep your local saves.',
  upload: 'Cloud sync reported an error while finishing. The latest progress may not be available on other devices. Keep your local saves.',
};

/** Observe known runtime diagnostics, not arbitrary HRESULTs or game exits.
 * A successful request/provider cannot clear another provider's failure: the
 * legacy text protocol has no provider identity or whole-session cloud ack. */
export const cloudConflictRetryMessage = 'Cloud sync is paused. Close the game, then start it again and choose a save in the conflict dialog. Keep your local saves until your choice succeeds.';

export class CloudSaveDiagnostics {
  problem?: CloudSaveProblem;
  private conflictResolverSeen = false;

  get message(): string | undefined {
    return this.problem === 'conflict' && this.conflictResolverSeen ? cloudConflictRetryMessage
      : this.problem ? cloudSaveMessages[this.problem] : undefined;
  }

  observe(line: string): boolean {
    let problem: CloudSaveProblem | undefined;
    const resolution = line.match(/\bnexus-saves: conflict-resolution hr=(?:0x)?([0-9a-f]{1,8}) backups=retained\s*$/i);
    if (resolution && parseInt(resolution[1], 16) === 0x8083000a) {
      const changed = this.problem !== 'conflict' || !this.conflictResolverSeen;
      this.conflictResolverSeen = true;
      this.problem = 'conflict';
      return changed;
    }
    const init = line.match(/\bgdkc:initialize_provider cloud sync failed, hr (?:0x)?([0-9a-f]{8})\./i);
    if (init) problem = init[1].toLowerCase() === '8083000a' ? 'conflict' : 'unavailable';
    else if (/\bgdkc:cloud_disable cloud saves disabled for this session\b/i.test(line)
      || /\bxodus-savesync: cloud 0 downloaded \d+ uploaded \d+\s*$/.test(line)) problem = 'unavailable';
    else if (/\bgdkc:[\w]+ (?:final cloud upload failed|cloud save session release failed|file save provider failed)\b/i.test(line)) problem = 'upload';
    else {
      const files = line.match(/\bnexus-files: final-sync hr=(?:0x)?([0-9a-f]{1,8}) uploaded=\d+\s*$/i);
      if (files && (parseInt(files[1], 16) >>> 31) === 1) problem = 'upload';
      const playfab = line.match(/\bNexus cloud saves: (session setup|final upload|session closed|runtime drain complete) hr=([0-9a-f]{8})\s*$/i);
      if (playfab && (parseInt(playfab[2], 16) >>> 31) === 1)
        problem = playfab[1] === 'session setup' ? 'unavailable' : 'upload';
    }
    if (!problem || this.problem === problem || this.problem === 'conflict') return false;
    // Keep the more specific final-transfer error when another provider is unavailable.
    if (this.problem === 'upload' && problem === 'unavailable') return false;
    this.problem = problem;
    return true;
  }
}

/** A Steam-only launcher normally quits after cleanup. Await the warning and
 * leave its window open, so missing desktop notifications cannot hide it. */
export async function warnShortcutCloudFailure(shortcutOnly: boolean, warning: string | undefined,
  ui: { showLauncher(): Promise<void>; warn(message: string): Promise<unknown> }): Promise<void> {
  if (!shortcutOnly || !warning) return;
  await ui.showLauncher();
  await ui.warn(warning);
}
