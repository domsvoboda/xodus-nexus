import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runtimeFamilies, runtimeFamilyLabels } from '../shared/runtime-selection.js';
import type { RuntimeManager } from './runtime.js';
import type { PreparedComponentUpdate } from './component-updates.js';
/** Read only discovery; absent families and unknown channels never become installers. */
export async function prepareManagedComponentUpdates(runtime: RuntimeManager, onStatus: () => void): Promise<PreparedComponentUpdate[]> {
    const root = runtime.current.runtimeRoot;
    await runtime.refreshFamilies();
    const entries: PreparedComponentUpdate[] = [];
    for (const family of runtimeFamilies) {
        const installed = runtime.current.managedFamilies?.find(row => row.id === family);
        const item = { id: 'runtime-' + family, component: 'runtime' as const, label: runtimeFamilyLabels[family], currentVersion: installed?.version,
            state: 'skipped' as 'ready' | 'unchanged' | 'skipped' | 'deferred', reason: installed?.installed ? 'The installed release channel could not be verified.' : 'This optional runtime family is not installed.' };
        if (!installed?.installed || !installed.channel) {
            entries.push({ item, isCurrent: async () => false, apply: async () => { throw Error(item.reason); } });
            continue;
        }
        const pointerFile = path.join(root, 'variants', family, 'current.json');
        const before = await fs.readFile(pointerFile);
        const policy = { allowCachyos: family === 'nexus-cachyos', allowPrerelease: installed.channel === 'prerelease' };
        const checked = await runtime.checkManagedRuntimeUpdate(family, installed.channel, onStatus), target = runtime.managedTarget(family);
        if (checked.error || !target) {
            entries.push({ item: { ...item, state: 'deferred', reason: (checked.error ?? 'No verified runtime release is available.') + ' Check again after updating or restarting the required component.' }, isCurrent: async () => false, apply: async () => { throw Error('No runtime target.'); } });
            continue;
        }
        if (checked.available?.candidateSha256 !== target.candidateSha256) {
            entries.push({ item: { ...item, state: 'deferred', reason: 'Runtime release selection changed while checking. Check again.' }, isCurrent: async () => false, apply: async () => { throw Error('Runtime release selection changed.'); } });
            continue;
        }
        if (target.prerelease !== (installed.channel === 'prerelease')) {
            entries.push({ item: { ...item, state: 'skipped', reason: 'The proposed release uses a different channel. Choose it explicitly in runtime settings.' }, isCurrent: async () => false, apply: async () => { throw Error('Runtime release channel changed.'); } });
            continue;
        }
        let activatedBuild: string | undefined, durability: string | undefined;
        const same = async () => {
            if (runtime.current.runtimeRoot !== root)
                return false;
            try {
                await runtime.refreshFamilies();
                const current = runtime.current.managedFamilies?.find(row => row.id === family)?.installed;
                return (await fs.readFile(pointerFile)).equals(before) && current?.buildId === installed.installed!.buildId && current.manifestSha256 === installed.installed!.manifestSha256 && current.sourceCommit === installed.installed!.sourceCommit;
            }
            catch {
                return false;
            }
        };
        entries.push({ item: { ...item, state: checked.updateAvailable ? 'ready' : 'unchanged', targetVersion: target.tag, reason: undefined },
            isCurrent: same,
            apply: async () => {
                if (!await same())
                    throw Error('The installed runtime changed. Check again.');
                const result = await runtime.installPreparedManagedRuntime(family, target, policy, onStatus);
                activatedBuild = result.buildId;
                durability = result.durability;
                if (!result.success)
                    throw Object.assign(Error(result.error ?? 'Runtime installation failed.'), { committed: result.committed, retryable: result.committed && result.durability !== 'confirmed' ? false : undefined });
                return { committed: result.committed };
            },
            reconcile: async () => {
                if (runtime.current.runtimeRoot !== root || !activatedBuild)
                    throw Object.assign(Error('Runtime activation context changed. Check again.'), { retryable: false });
                await runtime.refreshFamilies();
                const current = runtime.current.managedFamilies?.find(row => row.id === family)?.installed;
                const pointer = JSON.parse(await fs.readFile(pointerFile, 'utf8'));
                if (current?.buildId !== activatedBuild || current.sourceCommit !== target.commit || pointer.candidateSha256 !== target.candidateSha256)
                    throw Object.assign(Error('The activated runtime changed. Check again.'), { retryable: false });
                if (durability !== 'confirmed')
                    throw Object.assign(Error('The runtime is selected, but its saved selection still needs manual confirmation.'), { retryable: false });
                onStatus();
                return {};
            },
        });
    }
    return entries;
}
/** Update the existing global Standard selection within its recorded channel,
 * preserving prefix roots and per-game family settings. */
export async function prepareLegacyComponentUpdate(runtime: RuntimeManager, callbacks: import('./runtime.js').LegacyRuntimeUpdateCallbacks, onStatus: () => void): Promise<PreparedComponentUpdate> {
    const prepared = await runtime.prepareLegacyManagedUpdate(callbacks.configuredWine());
    const target = prepared.target;
    const item = { id: 'runtime-legacy', component: 'runtime' as const, label: 'Managed Standard runtime', currentVersion: prepared.currentVersion, targetVersion: target?.version, state: prepared.state, reason: prepared.skipReason };
    if (!target)
        return { item, isCurrent: async () => false, apply: async () => { throw Error('No supported Standard runtime update was selected.'); } };
    const same = async () => {
        if (runtime.current.runtimeRoot !== target.root || callbacks.configuredWine() !== target.installed.configuredWine)
            return false;
        const { legacyManagedState } = await import('./legacy-runtime-state.js');
        return (await legacyManagedState(target.root, callbacks.configuredWine()))?.identity === target.installed.identity;
    };
    return { item, isCurrent: same, apply: async () => {
            if (!await same())
                throw Error('The selected Standard runtime changed. Check again.');
            const result = await runtime.applyLegacyManagedUpdate(target, callbacks, onStatus);
            if (!result.success)
                throw Object.assign(Error(result.error ?? 'Updating the Standard runtime failed.'), { committed: result.committed, retryable: result.committed ? false : undefined });
            return { committed: result.committed };
        } };
}
