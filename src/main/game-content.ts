import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Game, GameContentItem, GameContentPlan, LibraryAccess } from '../shared/types.js';
import { children, parsePackageXml, single, type XmlNode } from './package-xml.js';
import { ContentCatalog, contentSkus, desktopContentPackages } from './content-catalog.js';

const productId = /^[A-Z0-9]{12}$/;
const contentId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const markerName = '.nexus-content-complete.json';
interface Manifest {
  storeId: string; name: string; publisher: string; version: string;
  related: string[]; allowed: string[]; dependency?: string;
}
export interface ContentPackage { productId: string; contentId: string; family: string; downloadBytes?: number }
type Access = Record<string, LibraryAccess>;
type RecordValue = Record<string, any>;

async function boundedBytes(file: string): Promise<Buffer> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1_048_576) throw Error('Package metadata is too large or not a file.');
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > stat.size) throw Error('Package metadata changed while reading.');
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
async function boundedFile(file: string): Promise<string> {
  return (await boundedBytes(file)).toString('utf8');
}
async function manifestFile(directory: string, filename: string): Promise<string> {
  const matches = (await fs.readdir(directory)).filter(name => name.toLowerCase() === filename.toLowerCase());
  if (matches.length !== 1) throw Error(`Missing or ambiguous ${filename}.`);
  return boundedFile(path.join(directory, matches[0]));
}
interface ContentConfiguration { xml: string; bytes: Buffer; source?: string; root?: string }
async function contentConfiguration(directory: string): Promise<ContentConfiguration> {
  const names = await fs.readdir(directory);
  const roots = names.filter(name => name.toLowerCase() === 'microsoftgame.config');
  const sources = names.filter(name => name.toLowerCase() === 'src');
  if (roots.length > 1 || sources.length > 1) throw Error('Missing or ambiguous MicrosoftGame.config.');
  const root = roots[0] && path.join(directory, roots[0]);
  let source: string | undefined;
  if (sources.length) {
    const folder = path.join(directory, sources[0]);
    const stat = await fs.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Content SRC path is not a real directory.');
    const files = (await fs.readdir(folder)).filter(name => name.toLowerCase() === 'microsoftgame.config');
    if (files.length > 1) throw Error('Missing or ambiguous MicrosoftGame.config.');
    if (files.length) source = path.join(folder, files[0]);
  }
  if (!root && !source) throw Error('Missing or ambiguous MicrosoftGame.config.');
  const bytes = await boundedBytes(source ?? root!);
  if (source && root && !(await boundedBytes(root)).equals(bytes)) throw Error('Conflicting root and SRC MicrosoftGame.config.');
  return { xml: bytes.toString('utf8'), bytes, source, root };
}
function contentPattern(pattern: string): RegExp {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.') + '$', 'i');
}
export function contentManifest(xml: string): Manifest {
  const root = parsePackageXml(xml);
  if (root.name.split(':').at(-1) !== 'Game') throw Error('Expected a Microsoft Game manifest.');
  const identity = single(root, 'Identity').attributes;
  const id = single(root, 'StoreId').text.trim();
  if (!productId.test(id) || !identity.Name || !identity.Publisher || !/^\d+\.\d+\.\d+\.\d+$/.test(identity.Version ?? '')
    || identity.Version.split('.').some(value => Number(value) > 65535)) throw Error('Invalid package identity.');
  const ids = (section: string, tag: string) => {
    const sections = children(root, section);
    if (sections.length > 1) throw Error('Ambiguous product relationships.');
    const result = sections.flatMap(node => children(node, tag).map(row => row.text.trim()));
    if (result.length > 128 || result.some(id => !productId.test(id))) throw Error('Invalid related product list.');
    return [...new Set(result)];
  };
  const registration = children(root, 'DesktopRegistration');
  if (registration.length > 1) throw Error('Ambiguous desktop registration.');
  const dependencies = registration.flatMap(node => children(node, 'MainPackageDependency'));
  if (dependencies.length > 1) throw Error('Ambiguous main package dependency.');
  return { storeId: id, name: identity.Name, publisher: identity.Publisher, version: identity.Version,
    related: ids('RelatedProducts', 'RelatedProduct'), allowed: ids('AllowedProducts', 'AllowedProduct'), dependency: dependencies[0]?.attributes.Name };
}
async function baseManifest(game: Game): Promise<Manifest> {
  const base = contentManifest(await manifestFile(game.path, 'MicrosoftGame.config'));
  if (base.storeId !== game.storeId) throw Error('The installed game Store ID changed. Reimport the game.');
  return base;
}
function packageChoice(base: Manifest, baseProduct: RecordValue | undefined, product: RecordValue | undefined): ContentPackage | undefined {
  const families = new Set(baseProduct ? desktopContentPackages(baseProduct).map(pkg => pkg.PackageFamilyName)
    .filter(name => typeof name === 'string' && name.startsWith(base.name + '_')) : []);
  const candidates = product && ['Durable', 'GameAddOn'].includes(product.ProductType) ? desktopContentPackages(product).filter(pkg => families.has(pkg.MainPackageFamilyNameForDlc)
    && contentId.test(pkg.ContentId) && typeof pkg.PackageFamilyName === 'string' && /^[A-Za-z0-9._-]+$/.test(pkg.PackageFamilyName)) : [];
  const unique = new Map(candidates.map(pkg => [pkg.ContentId.toLowerCase(), pkg]));
  if (unique.size !== 1 || new Set(candidates.map(pkg => pkg.PackageFamilyName)).size !== 1) return;
  const pkg = [...unique.values()][0];
  const downloadBytes = Number.isSafeInteger(pkg.MaxDownloadSizeInBytes) && pkg.MaxDownloadSizeInBytes > 0 ? pkg.MaxDownloadSizeInBytes : undefined;
  return { productId: product!.ProductId, contentId: pkg.ContentId.toLowerCase(), family: pkg.PackageFamilyName, downloadBytes };
}
export function contentOffers(base: Manifest, catalog: unknown, access: Access, verify: string[] = []): { items: GameContentItem[]; packages: ContentPackage[] } {
  const products = (catalog as RecordValue)?.Products;
  if (!Array.isArray(products) || products.length > 256) throw Error('Invalid content catalog.');
  const byId = new Map<string, RecordValue>();
  for (const product of products) {
    if (!product || typeof product.ProductId !== 'string' || !productId.test(product.ProductId) || byId.has(product.ProductId)) throw Error('Ambiguous content catalog.');
    byId.set(product.ProductId, product);
  }
  const baseProduct = byId.get(base.storeId);
  const selected: ContentPackage[] = [];
  const items = base.related.filter(id => id !== base.storeId).map((id): GameContentItem => {
    const product = byId.get(id);
    const title = product?.LocalizedProperties?.find((row: RecordValue) => typeof row?.ProductTitle === 'string')?.ProductTitle?.slice(0, 300) || id;
    const licensed = access[id];
    if (!licensed) {
      const pkg = verify.includes(id) ? packageChoice(base, baseProduct, product) : undefined;
      if (pkg) { selected.push(pkg); return { productId: id, title, status: 'verify', downloadBytes: pkg.downloadBytes,
        note: 'Included in an active offer. Xodus must verify this add-on license before downloading.' }; }
      return { productId: id, title, status: 'unlicensed', note: 'No active account license was verified.' };
    }
    const skus = contentSkus(product ?? {});
    if (product?.ProductType === 'Durable' && skus.some(props => Array.isArray(props.BundledSkus) && props.BundledSkus.length))
      return { productId: id, title, access: licensed, status: 'bundle', note: 'Content bundle. Its related add-ons are listed separately.' };
    if (product?.ProductType === 'Durable' && skus.length && skus.every(props => (props.PackagesDeclared ?? Object.hasOwn(props, 'Packages'))
      && (props.Packages === null || Array.isArray(props.Packages) && props.Packages.length === 0)))
      return { productId: id, title, access: licensed, status: 'license-only', note: 'No download required. The game must verify this license through the runtime.' };
    const pkg = packageChoice(base, baseProduct, product);
    if (!pkg) return { productId: id, title, access: licensed, status: 'unsupported', note: 'No unambiguous related PC MSIXVC content package was verified.' };
    selected.push(pkg);
    return { productId: id, title, access: licensed, status: 'available', downloadBytes: pkg.downloadBytes, note: 'Install-time licensing is checked again by Xodus.' };
  });
  return { items, packages: selected };
}

export class GameContent {
  private catalog: ContentCatalog;
  constructor(private dataRoot: string, fetcher: typeof fetch = fetch) { this.catalog = new ContentCatalog(fetcher); }
  /**
   * Public discovery hints only. Never reads credentials or grants runtime rights.
   * An offline launch skips the catalog, which cannot answer, and lists only
   * content installed on this device instead of waiting for the timeout.
   */
  async relatedProducts(game: Game, access: Access, market = 'US', signal = AbortSignal.timeout(5_000), offline = false): Promise<string[]> {
    const base = await baseManifest(game);
    const catalog = offline ? { related: [] } : await this.catalog.discover(base, access, market, game.offerProductId, signal);
    signal.throwIfAborted();
    const related = [...new Set([...catalog.related, ...await this.installedIds(game)])].filter(id => id !== base.storeId);
    if (related.length > 256 || related.some(id => !productId.test(id))) throw Error('Content discovery scope is too large.');
    return related;
  }
  private directory(game: Game, id?: string): string {
    if (id !== undefined && !productId.test(id)) throw Error('Invalid content product ID.');
    const key = createHash('sha256').update(game.id + '\0' + path.resolve(game.path)).digest('hex').slice(0, 32);
    return path.join(this.dataRoot, 'content', key, ...(id ? [id] : []));
  }
  private async safeDirectory(game: Game, id?: string, create = false): Promise<string> {
    const target = this.directory(game, id);
    // Managed content never writes into the base game. Reject symlink redirection
    // at every managed component, including persisted queue destinations.
    const relative = path.relative(this.dataRoot, target).split(path.sep);
    let current = await fs.realpath(this.dataRoot);
    for (const name of relative) {
      current = path.join(current, name);
      if (create) await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Managed content path is not a real directory.');
    }
    if (/[;\r\n]/.test(current)) throw Error('Content paths cannot contain semicolons or line breaks.');
    return current;
  }
  private async validate(game: Game, id: string, directory: string, family?: string): Promise<Manifest & { configuration: ContentConfiguration }> {
    const base = await baseManifest(game);
    const configuration = await contentConfiguration(directory);
    const content = contentManifest(configuration.xml);
    const appx = parsePackageXml(await manifestFile(directory, 'appxmanifest.xml'));
    const identity = single(appx, 'Identity').attributes;
    const dependency = single(single(appx, 'Dependencies'), 'MainPackageDependency').attributes;
    if (appx.name.split(':').at(-1) !== 'Package' || content.storeId !== id || content.publisher !== base.publisher || content.dependency !== base.name || !content.allowed.includes(base.storeId)
      || identity.Name !== content.name || identity.Publisher !== content.publisher || identity.Version !== content.version
      || dependency.Name !== base.name || (family && !family.startsWith(content.name + '_'))) throw Error('Downloaded content does not match the game/package identity.');
    const layouts = (await fs.readdir(directory)).filter(name => /^layout_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.xml$/i.test(name));
    if (layouts.length !== 1) throw Error('Missing or ambiguous content layout.');
    const layout = parsePackageXml(await boundedFile(path.join(directory, layouts[0])));
    if (layout.name !== 'Package') throw Error('Unsupported content layout.');
    const groups: XmlNode[] = [];
    function visit(node: XmlNode, depth: number) {
      if (depth > 16 || groups.length > 256) throw Error('Content layout limit exceeded.');
      if (node.name === 'FileGroup') groups.push(node);
      node.children.forEach(child => visit(child, depth + 1));
    }
    visit(layout, 0);
    if (!groups.length || groups.length > 256) throw Error('Content layout contains no supported file groups.');
    if (configuration.source) {
      const parts = (value: string) => value.split(/[/\\]/).filter(part => part && part !== '.');
      const mappings = groups.filter(group => {
        const source = parts(group.attributes.SourcePath ?? '').join('/').toLowerCase();
        const include = parts(group.attributes.Include ?? '');
        const destination = parts(group.attributes.DestinationPath ?? '');
        return source === 'src' && include.length === 1 && !destination.length
          && !group.attributes.Exclude && contentPattern(include[0]).test('MicrosoftGame.config');
      });
      if (mappings.length !== 1) throw Error('SRC MicrosoftGame.config must be mapped to the package root by its layout.');
    }
    for (const group of groups) {
      const source = group.attributes.SourcePath, include = group.attributes.Include;
      const valid = (value: string | undefined) => value && !/^[/\\]/.test(value) && !/[:\x00-\x1f]/.test(value) && !value.split(/[/\\]/).includes('..');
      if (!valid(source) || !valid(include) || /[*?]/.test(source)) throw Error('Unsupported content layout path.');
      const parts = [...source.split(/[/\\]/), ...include.split(/[/\\]/)].filter(part => part && part !== '.');
      const pattern = parts.pop();
      if (!pattern || parts.some(part => /[*?]/.test(part))) throw Error('Unsupported content layout wildcard.');
      let folder = directory;
      for (const part of parts) {
        const matches = (await fs.readdir(folder)).filter(name => name.toLowerCase() === part.toLowerCase());
        if (matches.length !== 1) throw Error('Missing or ambiguous content payload directory.');
        folder = path.join(folder, matches[0]);
        if (!(await fs.lstat(folder)).isDirectory()) throw Error('Invalid content payload directory.');
      }
      const match = contentPattern(pattern);
      const names = await fs.readdir(folder);
      if (names.length > 4096) throw Error('Content payload directory limit exceeded.');
      let found = false;
      for (const name of names.filter(name => match.test(name))) if ((await fs.lstat(path.join(folder, name))).isFile()) { found = true; break; }
      if (!found) throw Error('A file group declared by the content layout is missing.');
    }
    return { ...content, configuration };
  }
  async plan(game: Game, readAccess: () => Promise<{ checkedAt: string; accessByProductId: Access }>, market = 'US'): Promise<{ plan: GameContentPlan; packages: ContentPackage[] }> {
    const base = await baseManifest(game);
    const access = await readAccess();
    const catalog = await this.catalog.discover(base, access.accessByProductId, market, game.offerProductId);
    const offers = contentOffers({ ...base, related: catalog.related }, catalog, access.accessByProductId, catalog.verify);
    const installed = new Set(await this.installedIds(game));
    for (const item of offers.items) if (installed.has(item.productId)) {
      if (item.status === 'verify') { item.note = 'Installed files retained. Xodus must verify this add-on license before repair.'; continue; }
      item.status = 'installed'; item.note = item.access ? 'Installed. The runtime verifies the license when requested.' : 'Installed files retained, but no active account license was verified.';
    }
    return { plan: { gameId: game.id, checkedAt: access.checkedAt, items: offers.items }, packages: offers.packages };
  }
  async prepare(game: Game, pkg: ContentPackage, market = 'US'): Promise<string> {
    const base = await baseManifest(game);
    if (!productId.test(pkg.productId) || !contentId.test(pkg.contentId)) throw Error('Invalid content installation.');
    const catalog = await this.catalog.discover(base, {}, market, pkg.productId);
    const expected = catalog.related.includes(pkg.productId) ? packageChoice(base, catalog.Products.find(p => p.ProductId === base.storeId), catalog.Products.find(p => p.ProductId === pkg.productId)!) : undefined;
    if (!expected || expected.contentId !== pkg.contentId || expected.family !== pkg.family) throw Error('Invalid content installation.');
    const root = await fs.realpath(this.dataRoot), gameRoot = await fs.realpath(game.path);
    const target = path.join(root, path.relative(this.dataRoot, this.directory(game, pkg.productId)));
    if (target === gameRoot || target.startsWith(gameRoot + path.sep) || gameRoot.startsWith(target + path.sep)) throw Error('Content storage overlaps the base game. Choose a separate runtime storage folder.');
    const directory = await this.safeDirectory(game, pkg.productId, true);
    await fs.unlink(path.join(directory, markerName)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return directory;
  }
  async complete(game: Game, pkg: ContentPackage): Promise<void> {
    const directory = await this.safeDirectory(game, pkg.productId);
    const content = await this.validate(game, pkg.productId, directory, pkg.family);
    if (!content.configuration.root) {
      // Runtime discovery expects root metadata. Materialize only the exact
      // layout-declared, fully validated config, preserving its original copy.
      if (!(await boundedBytes(content.configuration.source!)).equals(content.configuration.bytes))
        throw Error('Content configuration changed during installation.');
      await fs.writeFile(path.join(directory, 'MicrosoftGame.config'), content.configuration.bytes, { flag: 'wx', mode: 0o600 });
      await this.validate(game, pkg.productId, directory, pkg.family);
    }
    const temporary = path.join(directory, markerName + '.' + randomUUID() + '.tmp');
    await fs.writeFile(temporary, JSON.stringify({ schema: 1, productId: pkg.productId, contentId: pkg.contentId, parent: game.storeId, name: content.name, version: content.version }), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, path.join(directory, markerName));
  }
  private async installedIds(game: Game): Promise<string[]> {
    const base = await baseManifest(game), installed: string[] = [];
    let ids: string[];
    try { ids = await fs.readdir(await this.safeDirectory(game)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (ids.length > 256) throw Error('Too many managed content directories.');
    for (const id of ids.filter(id => productId.test(id))) {
      try {
        const directory = await this.safeDirectory(game, id);
        const marker = JSON.parse(await boundedFile(path.join(directory, markerName)));
        if (marker.schema !== 1 || marker.parent !== base.storeId || marker.productId !== id || !contentId.test(marker.contentId)) continue;
        const content = await this.validate(game, id, directory);
        if (marker.name === content.name && marker.version === content.version) installed.push(id);
      } catch { /* Missing/incomplete content is never promoted to installed. */ }
    }
    return installed;
  }
  async roots(game: Game): Promise<string[]> {
    const roots: string[] = [];
    for (const id of await this.installedIds(game)) roots.push(await this.safeDirectory(game, id));
    // Runtime discovery is bounded and uses MAX_PATH. Fail explicitly, not by
    // silently omitting installed content or splitting a path into extra roots.
    if (roots.some(root => root.length + 2 >= 260) || roots.join(';').length > 16000) throw Error('Managed content paths exceed runtime discovery limits.');
    return roots;
  }
}
