import { promises as fs } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { stripAnsi } from '../shared/utils.js';

export interface OutputTailOptions {
  /** Start at this byte offset; the end of the file when undefined. */
  from?: number;
  pollMs?: number;
  /** Once everything up to this size is read, truncate so the file stays small. */
  rotateBytes?: number;
}

/**
 * Follows a file a game appends its output to (O_APPEND), as lines. A file
 * instead of a pipe means the game never sees a broken pipe when the daemon
 * dies, and a restarted daemon picks the same file up again.
 */
export class OutputTail {
  private offset: number | undefined;
  private readonly decoder = new StringDecoder('utf8');
  private buffered = '';
  private timer: ReturnType<typeof setInterval> | undefined;
  private reading: Promise<void> | undefined;

  constructor(readonly file: string, private readonly onLine: (line: string) => void, private readonly options: OutputTailOptions = {}) {
    this.offset = options.from;
  }

  start(): this {
    this.timer ??= setInterval(() => void this.read(), this.options.pollMs ?? 250);
    this.timer.unref?.();
    void this.read();
    return this;
  }

  /** Reads what is left, emits a trailing partial line and stops following. */
  async drain(): Promise<void> {
    this.stop();
    await this.read();
    this.buffered += this.decoder.end();
    if (this.buffered.trim()) this.onLine(stripAnsi(this.buffered).trimEnd());
    this.buffered = '';
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private read(): Promise<void> {
    return this.reading ??= this.readOnce().catch(() => undefined).finally(() => { this.reading = undefined; });
  }

  private async readOnce(): Promise<void> {
    const handle = await fs.open(this.file, 'r');
    try {
      let size = (await handle.stat()).size;
      if (this.offset === undefined) this.offset = size;
      // Truncated underneath us (our own rotation, or a new launch): start over.
      if (size < this.offset) this.offset = 0;
      const chunk = Buffer.alloc(65_536);
      while (this.offset < size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - this.offset), this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        this.consume(chunk.subarray(0, bytesRead));
        if (this.offset >= size) size = (await handle.stat()).size;
      }
      const rotate = this.options.rotateBytes ?? 8_000_000;
      // The writer uses O_APPEND, so after a truncate its next write lands at 0.
      if (this.offset >= rotate && this.offset === size) { await fs.truncate(this.file, 0); this.offset = 0; }
    } finally { await handle.close(); }
  }

  private consume(chunk: Buffer): void {
    this.buffered += this.decoder.write(chunk);
    const lines = this.buffered.split(/[\r\n]/);
    this.buffered = lines.pop() ?? '';
    for (const raw of lines) {
      const line = stripAnsi(raw).trimEnd();
      if (line) this.onLine(line);
    }
    if (this.buffered.length > 64_000) this.buffered = this.buffered.slice(-64_000);
  }
}
