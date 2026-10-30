import type { LaunchOptions } from './game-session.js';

/** Serialize launch preparation, coalesce duplicate shortcuts, never queue games. */
export class ShortcutLaunch {
  private starting?: string;
  constructor(private active: () => string | undefined, private launch: (id: string, options?: LaunchOptions) => Promise<void>) {}
  async request(id: string, options?: LaunchOptions): Promise<void> {
    if (this.starting === id || this.active() === id) return;
    if (this.starting || this.active()) throw new Error('Another game is already starting or running.');
    this.starting = id;
    try { await this.launch(id, options); } finally { this.starting = undefined; }
  }
  get preparing(): boolean { return Boolean(this.starting); }
}
