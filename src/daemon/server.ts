import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'node:net';
import { encodeFrame, FrameReader, parseClientFrame, ProtocolError, type ClientFrame, type ClientKind, type DaemonFrame, type DaemonState } from '../shared/daemon-protocol.js';
import { DaemonError, type GameController } from './controller.js';

interface Client {
  id: string;
  socket: Socket;
  reader: FrameReader;
  kind?: ClientKind;
  subscribed: boolean;
}

export interface ServerOptions {
  version: string;
  profileId: string;
  log(line: string): void;
  /** Called when the daemon should exit once idle (the `reload` frame). */
  requestExitWhenIdle(): void;
}

/** Framed connections, the hello handshake, ownership and fan-out of state. */
export class DaemonServer {
  private readonly clients = new Map<string, Client>();
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly controller: GameController, private readonly options: ServerOptions) {
    this.unsubscribe.push(
      controller.onState(state => this.broadcast({ schema: 1, type: 'state', state }, client => client.subscribed || client.id === controller.owner)),
      controller.onLog((operationId, line) => this.broadcast({ schema: 1, type: 'log', operationId, line: line.slice(0, 4096) }, client => client.subscribed || client.id === controller.owner)),
      controller.onExit((operationId, code, status) => this.broadcast({ schema: 1, type: 'exit', operationId, code, status }, client => client.subscribed || client.id === controller.owner)),
    );
  }

  get clientCount(): number { return this.clients.size; }

  attach(server: Server): void {
    server.on('connection', socket => this.accept(socket));
  }

  accept(socket: Socket): void {
    const client: Client = { id: randomUUID(), socket, reader: new FrameReader(), subscribed: false };
    this.clients.set(client.id, client);
    socket.setNoDelay?.(true);
    socket.on('data', (chunk: Buffer) => {
      let lines: string[];
      try { lines = client.reader.push(chunk); }
      catch (error) { this.reject(client, error); return; }
      for (const line of lines) {
        let frame: ClientFrame;
        try { frame = parseClientFrame(line); }
        catch (error) { this.reject(client, error); return; }
        void this.handle(client, frame).catch(error => this.options.log(`Client ${client.id} request failed: ${(error as Error).message}`));
      }
    });
    socket.on('error', error => this.options.log(`Client ${client.id} socket error: ${error.message}`));
    socket.on('close', () => {
      this.clients.delete(client.id);
      this.controller.ownerLost(client.id);
    });
  }

  close(): void {
    for (const dispose of this.unsubscribe) dispose();
    for (const client of this.clients.values()) client.socket.destroy();
    this.clients.clear();
  }

  private send(client: Client, frame: DaemonFrame): void {
    if (client.socket.destroyed) return;
    try { client.socket.write(encodeFrame(frame)); }
    catch (error) { this.options.log(`Could not send to client ${client.id}: ${(error as Error).message}`); }
  }

  private broadcast(frame: DaemonFrame, accept: (client: Client) => boolean): void {
    for (const client of this.clients.values()) if (client.kind && accept(client)) this.send(client, frame);
  }

  private reject(client: Client, error: unknown): void {
    const message = error instanceof ProtocolError ? error.message : 'Invalid request.';
    this.send(client, { schema: 1, type: 'error', code: 'schema', message });
    client.socket.end();
  }

  private async handle(client: Client, frame: ClientFrame): Promise<void> {
    if (frame.type === 'hello') {
      client.kind = frame.client;
      this.send(client, { schema: 1, type: 'hello', daemonVersion: this.options.version, profileId: this.options.profileId, state: this.controller.state() });
      return;
    }
    if (!client.kind) { this.reject(client, new ProtocolError('Say hello first.')); return; }
    switch (frame.type) {
      case 'ping': this.send(client, { schema: 1, type: 'pong' }); return;
      case 'subscribe': client.subscribed = true; this.send(client, { schema: 1, type: 'state', state: this.controller.state() }); return;
      case 'reload': this.options.requestExitWhenIdle(); return;
      case 'attach': {
        if (this.controller.attach(frame.operationId, client.id)) this.send(client, { schema: 1, type: 'state', state: this.controller.state() });
        else this.send(client, { schema: 1, type: 'error', code: 'game-not-found', message: 'No such game is running.' });
        return;
      }
      case 'cancel': {
        try { await this.controller.cancel(); }
        catch (error) { this.send(client, { schema: 1, type: 'error', requestId: frame.requestId, code: 'internal', message: (error as Error).message }); }
        return;
      }
      case 'launch': {
        try {
          const active = await this.controller.launch({ gameId: frame.gameId, env: frame.env, cwd: frame.cwd }, frame.attach ? client.id : undefined);
          this.send(client, { schema: 1, type: 'accepted', requestId: frame.requestId, operationId: active.operationId });
        } catch (error) {
          const code = error instanceof DaemonError ? error.code : 'internal';
          this.send(client, { schema: 1, type: 'error', requestId: frame.requestId, code, message: (error as Error).message });
        }
        return;
      }
    }
  }
}

export type { DaemonState };
