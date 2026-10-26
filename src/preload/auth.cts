// Dedicated sandboxed remote-page preload. No launcher API, Node API, file or
// token-storage access is exposed. The main process independently checks sender.
import { contextBridge, ipcRenderer, webFrame } from 'electron';
const hosts = ['login.live.com', 'account.live.com', 'login.microsoftonline.com', 'login.microsoft.com', 'account.microsoft.com', 'sisu.xboxlive.com'];

// Runs in the page's main world. It can only cancel this page's own active
// WebAuthn requests or explicitly request the browser fallback. Never authenticate,
// choose a credential, alter verification results or expose Node.
function installPasskeyCancellation(strings: Record<string, string> = {}): void {
  const credentials = navigator.credentials;
  if (!credentials || typeof credentials.get !== 'function') return;
  const original = credentials.get;
  const active = new Set<AbortController>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let eligible = false;
  let panel: HTMLElement | undefined;
  const hide = () => { if (timer) clearTimeout(timer); timer = undefined; eligible = false; panel?.remove(); panel = undefined; };
  const show = () => {
    if (!active.size || panel || !document.body) return;
    panel = document.createElement('div');
    panel.setAttribute('data-nexus-passkey-control', '');
    panel.style.cssText = 'all:initial;display:block;position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;max-width:620px;margin:0 auto;color-scheme:dark';
    const shadow = panel.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{font-family:system-ui,sans-serif;font-size:13px;color:#f4f5f6}
      .panel{box-sizing:border-box;display:flex;align-items:center;gap:18px;padding:16px;font:13px system-ui,sans-serif;color:#f4f5f6;background:#25292e;border:1px solid #484e55;border-radius:8px;box-shadow:0 8px 28px #0004}
      .copy{flex:1;min-width:0}.actions{display:grid;gap:8px;flex:none}.brand{font-size:10px;font-weight:700;letter-spacing:.8px;color:#aeb5bd;margin-bottom:5px}
      h2{font-size:14px;line-height:1.4;margin:0 0 4px;font-weight:650}p{font-size:12px;line-height:1.5;color:#bdc3cb;margin:0}
      button{flex:none;font:600 13px system-ui,sans-serif;color:#f4f5f6;background:#353b42;border:1px solid #626a74;border-radius:4px;padding:10px 12px;cursor:pointer}
      button:hover{background:#454d57}button:focus-visible{outline:2px solid #9acb87;outline-offset:3px}
      button.browser{background:#357e2c;border-color:#4d9345}button:disabled{opacity:.6;cursor:wait}.error{color:#f1b3a9;margin-top:8px}
      @media(max-width:460px){.panel{align-items:stretch;flex-direction:column;gap:12px}button{width:100%}}
    </style><section class="panel" role="region" aria-label="Xodus Nexus passkey help">
      <div class="copy"><div class="brand">XODUS NEXUS</div><h2>Passkey taking too long?</h2>
      <p>If your account uses a passkey or security key, continue in Google Chrome. Or cancel this request to choose another method.</p><p class="error" role="status" hidden></p></div>
      <div class="actions"><button type="button" class="browser" data-browser>Continue in browser</button><button type="button" data-cancel>Cancel passkey request</button></div></section>`;
    // Translations are assigned as text, never inserted into the remote page as HTML.
    for (const [key, selector] of Object.entries({label:'section',title:'h2',help:'.copy > p:not(.error)',browser:'[data-browser]',cancel:'[data-cancel]'})) {
      if (typeof strings[key] !== 'string' || strings[key].length > 12000) continue;
      const element = shadow.querySelector(selector);
      if (key === 'label') element?.setAttribute('aria-label', strings[key]);
      else if (element) element.textContent = strings[key];
    }
    shadow.querySelector('[data-cancel]')!.addEventListener('click', () => {
      for (const controller of active) controller.abort();
      hide();
    });
    shadow.querySelector('[data-browser]')!.addEventListener('click', async () => {
      const button = shadow.querySelector<HTMLButtonElement>('[data-browser]')!;
      const error = shadow.querySelector<HTMLElement>('.error')!;
      button.disabled = true; error.hidden = true;
      try {
        const result = await (globalThis as any).__nexusAuth.continueInBrowser();
        if (!result?.ok) throw Error('Browser unavailable');
      } catch {
        button.disabled = false;
        error.textContent = strings.error ?? 'Could not open browser sign-in. Google Chrome must be installed. Try again or choose another method.';
        error.hidden = false;
      }
    });
    document.body.appendChild(panel);
  };
  Object.defineProperty(credentials, 'get', { configurable: true, writable: true, value: function (this: CredentialsContainer, options?: CredentialRequestOptions) {
    if (!options?.publicKey) return Reflect.apply(original, this, [options]);
    // Leave malformed options to the native API's normal validation.
    const prior = options.signal;
    if (prior && (typeof prior.addEventListener !== 'function' || typeof prior.removeEventListener !== 'function')) return Reflect.apply(original, this, [options]);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(prior?.reason);
    if (prior?.aborted) forwardAbort();
    else prior?.addEventListener('abort', forwardAbort, { once: true });
    active.add(controller);
    timer ??= setTimeout(() => { eligible = true; show(); }, 4000);
    const finish = () => { prior?.removeEventListener('abort', forwardAbort); active.delete(controller); if (!active.size) hide(); };
    try {
      const request = Object.create(options, { signal: { value: controller.signal, enumerable: true } });
      return Promise.resolve(Reflect.apply(original, this, [request]))
        .then(value => { finish(); return value; }, error => { finish(); throw error; });
    } catch (error) { finish(); throw error; }
  } });
  document.addEventListener('DOMContentLoaded', () => { if (eligible) show(); }, { once: true });
  window.addEventListener('pagehide', hide, { once: true });
}

if (window === window.top && location.protocol === 'https:' && !location.port && hosts.includes(location.hostname)) {
  let strings: Record<string, string> = {};
  try {
    const argument = typeof process === 'undefined' ? undefined : process.argv.find(value => value.startsWith('--nexus-auth-ui='));
    if (argument && argument.length < 80_000) {
      const parsed: unknown = JSON.parse(argument.slice('--nexus-auth-ui='.length));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const key of ['label','title','help','browser','cancel','error']) {
          const value = (parsed as Record<string, unknown>)[key];
          if (typeof value === 'string' && value.length <= 12000) strings[key] = value;
        }
      }
    }
  } catch { /* English controls remain usable with a malformed optional resource. */ }
  contextBridge.exposeInMainWorld('__nexusAuth', {
    continueInBrowser: () => ipcRenderer.invoke('nexus-auth:browser'),
    notify: (payload: unknown) => {
      if (typeof payload === 'string' && payload.length <= 65_536) ipcRenderer.send('nexus-auth:notify', payload);
    },
  });
  // Chromium already owns window.external. Install only the Wry-compatible
  // method on that object, before the sign-in page's inline scripts execute.
  void webFrame.executeJavaScript(`Object.defineProperty(globalThis.external, 'notify', {
    value: payload => globalThis.__nexusAuth.notify(payload),
    configurable: false,
    writable: false
  }); (${installPasskeyCancellation.toString()})(${JSON.stringify(strings)});`);
}
