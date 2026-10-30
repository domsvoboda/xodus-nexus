import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { encodeFrame, FrameReader, parseDaemonFrame, type ClientFrame, type DaemonFrame } from '../shared/daemon-protocol.js';

export interface DaemonConnectionEvents {
  frame: [DaemonFrame];
  close: [Error | undefined];
}

/** The socket a profile's daemon listens on, inside the user's runtime directory. */
export function daemonSocketPath(runtimeDir: string, profileId: string): string {
  return `${runtimeDir}/xodus-nexus/${profileId}.sock`;
}

/**
 * One framed connection to the daemon. Shared by the thin Steam client and the
 * Electron launcher; neither reconnects here, that is the caller's policy.
 */
export class DaemonConnection extends EventEmitter<DaemonConnectionEvents> {
  private readonly reader = new FrameReader();
  private closed = false;

  private constructor(private readonly socket: Socket) {
    super();
    socket.on('data', (chunk: Buffer) => {
      let lines: string[];
      try { lines = this.reader.push(chunk); }
      catch (error) { this.fail(error as Error); return; }
      for (const line of lines) {
        let frame: DaemonFrame;
        try { frame = parseDaemonFrame(line); }
        catch (error) { this.fail(error as Error); return; }
        this.emit('frame', frame);
      }
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.finish(undefined));
  }

  static connect(socketPath: string, timeoutMs = 5_000): Promise<DaemonConnection> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Timed out connecting to the Nexus background service.')); }, timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); socket.removeListener('error', failed); resolve(new DaemonConnection(socket)); });
      const failed = (error: Error) => { clearTimeout(timer); reject(error); };
      socket.once('error', failed);
    });
  }

  send(frame: ClientFrame): void {
    if (this.closed) throw new Error('The connection to the Nexus background service is closed.');
    this.socket.write(encodeFrame(frame));
  }

  /** Waits for the next frame matching `accept`; rejects when the connection closes first. */
  next<T extends DaemonFrame>(accept: (frame: DaemonFrame) => frame is T, timeoutMs?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => { cleanup(); reject(new Error('The Nexus background service did not answer in time.')); }, timeoutMs) : undefined;
      const onFrame = (frame: DaemonFrame) => { if (accept(frame)) { cleanup(); resolve(frame); } };
      const onClose = (error: Error | undefined) => { cleanup(); reject(error ?? new Error('The Nexus background service closed the connection.')); };
      const cleanup = () => { if (timer) clearTimeout(timer); this.off('frame', onFrame); this.off('close', onClose); };
      this.on('frame', onFrame);
      this.on('close', onClose);
    });
  }

  close(): void {
    if (this.closed) return;
    this.socket.end();
    this.socket.destroy();
  }

  get open(): boolean { return !this.closed; }

  private fail(error: Error): void {
    if (this.closed) return;
    this.socket.destroy();
    this.finish(error);
  }

  private finish(error: Error | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', error);
  }
}
