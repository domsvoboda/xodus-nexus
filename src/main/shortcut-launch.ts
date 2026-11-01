/** Serialize launch preparation, coalesce duplicate shortcuts, never queue games. */
export class ShortcutLaunch<Context = undefined> {
  private starting?: string;
  private pending?: Promise<void>;
  constructor(private active: () => string | undefined, private launch: (id: string, context?: Context) => Promise<void>) {}
  async request(id: string, context?: Context): Promise<void> {
    if (this.starting === id) return this.pending;
    if (this.active() === id) return;
    if (this.starting || this.active()) throw new Error('Another game is already starting or running.');
    this.starting = id;
    this.pending = (async () => this.launch(id, context))();
    try { await this.pending; } finally { this.starting = undefined; this.pending = undefined; }
  }
  get preparing(): boolean { return Boolean(this.starting); }
}
