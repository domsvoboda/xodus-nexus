import { BrowserWindow } from 'electron';

/** Local branding only. No network, account data or page-supplied HTML. */
export async function nexusSteamArtwork(icon: Buffer): Promise<{ cover: Buffer; wide: Buffer }> {
  return renderSteamArtwork((width, height) => `
      main{text-align:center;width:100%;padding:48px}img{width:${width > height ? 220 : 280}px;height:${width > height ? 220 : 280}px;object-fit:contain;display:block;margin:0 auto 32px}h1{font-size:${width > height ? 64 : 52}px;letter-spacing:3px;margin:0;font-weight:700}p{color:#aebcb6;font-size:21px;letter-spacing:2px;margin:24px 0 0}.line{height:4px;width:84px;background:#67b43c;margin:32px auto 0}
      </style></head><body><main><img src="data:image/png;base64,${icon.toString('base64')}" alt=""><h1>NEXUS</h1><div class="line"></div><p>YOUR PC GAMES, TOGETHER.</p></main>`, [[600, 900], [1280, 720]]);
}

/** Portrait library slot only. Keep the original image's proportions and the
 * separately supplied wide Home artwork unchanged. */
export async function gameSteamPortrait(cover: Buffer): Promise<Buffer> {
  const result = await renderSteamArtwork(() => `
    .backdrop{position:absolute;inset:-40px;background-image:url(data:image/png;base64,${cover.toString('base64')});background-position:center;background-size:cover;filter:blur(35px);opacity:.3}
    img{position:relative;width:100%;height:100%;object-fit:contain}
    </style></head><body><div class="backdrop"></div><img src="data:image/png;base64,${cover.toString('base64')}" alt="">`, [[600, 900]]);
  return result.cover;
}

async function renderSteamArtwork(content: (width: number, height: number) => string,
  sizes: [number, number][]): Promise<{ cover: Buffer; wide: Buffer }> {
  const window = new BrowserWindow({ show: false, width: 600, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  try {
    const render = async (width: number, height: number) => {
      window.setContentSize(width, height);
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>
      *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at 50% 30%,#173c32,#141c24 65%);color:#f4f6f5;font-family:Arial,sans-serif}
      ${content(width, height)}</body></html>`;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
            await window.webContents.executeJavaScript('Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.decode())])');
            return (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG();
          })(),
          new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(Error('Steam artwork rendering timed out.')), 5000); }),
        ]);
      } finally { if (timeout) clearTimeout(timeout); }
    };
    const cover = await render(...sizes[0]);
    return { cover, wide: sizes[1] ? await render(...sizes[1]) : cover };
  } finally { window.destroy(); }
}
