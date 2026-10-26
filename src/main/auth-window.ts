import { BrowserWindow, ipcMain, session, type Session, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trustedAuthUrl, type AuthFrame } from './auth-protocol.js';
import type { AuthView, AuthViewFactory } from './auth-transport.js';
import { AuthBrowserNotFoundError } from './auth-browser.js';
const folder = path.dirname(fileURLToPath(import.meta.url));
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; MSAppHost/3.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.26100';

export function authViewFactory(parent?: BrowserWindow, testSession?: Session, requestBrowser?: () => Promise<void>, localize: (text: string) => string = text => text): AuthViewFactory {
  return (send, cancel, fail): AuthView => {
    // No persist: prefix. Cookies are shared only between this attempt's steps.
    const isolated = testSession ?? session.fromPartition(`nexus-auth-${randomUUID()}`, { cache: false });
    isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on('will-download', event => event.preventDefault());
    let window: BrowserWindow | undefined, id: number | undefined, disposed = false;
    const notify = (event: IpcMainEvent, payload: unknown) => {
      if (!window || disposed || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
          !trustedAuthUrl(event.senderFrame.url) || !trustedAuthUrl(window.webContents.getURL()) || typeof payload !== 'string' || Buffer.byteLength(payload) > 65_536 || id === undefined) return;
      send(id, payload);
    };
    ipcMain.on('nexus-auth:notify', notify);
    let switching = false;
    const trustedSender = (event: IpcMainInvokeEvent) => !!window && !disposed && id !== undefined && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && trustedAuthUrl(event.senderFrame.url) && trustedAuthUrl(window.webContents.getURL());
    ipcMain.handle('nexus-auth:browser', async (event) => {
      if (!trustedSender(event) || switching || !requestBrowser) return { ok: false, message: 'Browser sign-in is unavailable.' };
      switching = true;
      try { await requestBrowser(); return { ok: true }; }
      catch (error) { switching = false; return { ok: false, message: error instanceof AuthBrowserNotFoundError ? error.message : 'Could not start Google Chrome for browser sign-in. Try again or choose another sign-in method.' }; }
    });
    function close() {
      const old = window; window = undefined; id = undefined;
      if (old && !old.isDestroyed()) old.destroy();
    }
    return {
      async open(frame: Extract<AuthFrame, { type: 'open' }>) {
        if (disposed || !trustedAuthUrl(frame.url)) throw Error('Unsupported sign-in URL.');
        close(); id = frame.session;
        const current = new BrowserWindow({
          width: 580, height: 760, parent, show: false, title: localize('Xodus sign in'), autoHideMenuBar: true,
          webPreferences: { session: isolated, preload: path.join(folder, '../preload/auth.cjs'), nodeIntegration: false, contextIsolation: true,
            additionalArguments: ['--nexus-auth-ui=' + JSON.stringify({
              label: localize('Xodus Nexus passkey help'), title: localize('Passkey taking too long?'),
              help: localize('If your account uses a passkey or security key, continue in Google Chrome. Or cancel this request to choose another method.'),
              browser: localize('Continue in browser'), cancel: localize('Cancel passkey request'),
              error: localize('Could not open browser sign-in. Google Chrome must be installed. Try again or choose another method.'),
            })].filter(argument => Buffer.byteLength(argument, 'utf8') <= 16000),
            sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false, navigateOnDragDrop: false },
        });
        window = current; current.webContents.setUserAgent(USER_AGENT);
        current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        const navigation = (event: Electron.Event, url: string) => { if (!trustedAuthUrl(url)) { event.preventDefault(); fail(); } };
        current.webContents.on('will-navigate', navigation);
        current.webContents.on('will-redirect', navigation);
        current.webContents.on('will-attach-webview', event => event.preventDefault());
        current.webContents.on('render-process-gone', () => { if (window === current && !disposed) fail(); });
        current.webContents.on('preload-error', () => { if (window === current && !disposed) fail(); });
        current.webContents.on('did-finish-load', () => {
          if (window !== current || id !== frame.session) return;
          const url = new URL(current.webContents.getURL());
          if (url.origin === 'https://login.live.com' && url.pathname === '/ppsecure/post.srf') {
            void current.webContents.executeJavaScript('JSON.stringify(globalThis.ServerData ?? null)').then(payload => {
              if (window === current && typeof payload === 'string' && payload !== 'null' && payload.length <= 65_536) send(frame.session, payload);
            }).catch(() => fail());
          }
        });
        current.on('closed', () => { if (window === current) { window = undefined; id = undefined; if (!disposed) cancel(frame.session); } });
        current.once('ready-to-show', () => { if (window === current) current.show(); });
        const extraHeaders = Object.entries(frame.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n');
        await current.loadURL(frame.url, { extraHeaders });
      },
      close(session) { if (id === session) close(); },
      async context(session, context) {
        const current = window;
        if (!current || id !== session || !trustedAuthUrl(current.webContents.getURL())) return;
        const message = JSON.stringify({ type: 'callback', value: { name: 'CloudExperienceHost.getContext', args: ['CloudExperienceHost', 'TokenBroker', 'TokenBroker', '{"PrivatePropertyBag":1,"PasswordlessConnect":1,"PreferAssociate":1,"ChromelessUI":0}'], context } });
        await current.webContents.executeJavaScript(`globalThis["CloudExperienceHost.Bridge.dispatchMessage"](${JSON.stringify(message)})`);
      },
      async dispose() { if (disposed) return; disposed = true; close(); ipcMain.removeListener('nexus-auth:notify', notify); ipcMain.removeHandler('nexus-auth:browser'); await isolated.clearStorageData(); },
    };
  };
}
