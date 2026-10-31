const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

/**
 * The dialog-only page the thin Steam client opens for a refused launch. Any
 * key, click or controller button closes it, since Game Mode may not map a
 * controller button to Enter.
 */
export function launchErrorPage(title: string, message: string, button: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title><style>
html,body{margin:0;height:100%;background:#111316;color:#e8eaed;font:18px system-ui,sans-serif}
main{box-sizing:border-box;height:100%;display:flex;flex-direction:column;justify-content:center;gap:16px;padding:32px 40px}
h1{margin:0;font-size:24px}p{margin:0;line-height:1.45;white-space:pre-wrap}
button{align-self:flex-start;margin-top:8px;padding:10px 28px;font:inherit;border:0;border-radius:6px;background:#3c8d2f;color:#fff}
</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><button autofocus>${escapeHtml(button)}</button></main>
<script>
const close = () => window.close();
addEventListener('keydown', close); addEventListener('click', close);
(function poll() { if (navigator.getGamepads().some(pad => pad && pad.buttons.some(b => b.pressed))) close(); else requestAnimationFrame(poll); })();
</script></body></html>`;
}
