/** One bounded read at a time, only while the Friends panel is visible. No sends. */
export class FriendsRefresh {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private running = false;
  private failures = 0;
  constructor(private read: () => Promise<boolean>, private visible: () => boolean, private interval = 15_000) {}
  start(): void { this.stopped = false; this.schedule(this.interval); }
  stop(): void { this.stopped = true; clearTimeout(this.timer); }
  wake(): void { if(!this.stopped && !this.running) this.schedule(this.interval); }
  private schedule(delay: number): void {
    clearTimeout(this.timer);
    if(!this.stopped) this.timer = setTimeout(() => { void this.tick(); }, delay);
  }
  private async tick(): Promise<void> {
    if(this.stopped || this.running) return;
    this.running = true;
    try {
      if(this.visible()) {
        const success = await this.read();
        this.failures = success ? 0 : Math.min(5, this.failures + 1);
      }
    } catch { this.failures = Math.min(5, this.failures + 1); }
    finally {
      this.running = false;
      this.schedule(Math.min(300_000, this.interval * 2 ** this.failures));
    }
  }
}
