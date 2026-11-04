import { randomUUID } from 'node:crypto';
import type { ComponentUpdateBatchResult, ComponentUpdateItemResult, ComponentUpdatePlan, ComponentUpdatePlanItem, ComponentUpdatesStatus } from '../shared/types.js';
import { ComponentUpdateAdmission, type ComponentUpdateOwner } from './component-update-admission.js';
export interface PreparedComponentUpdate {
    readonly item: ComponentUpdatePlanItem;
    /** Compare installed identity and context, never silently substitute latest. */
    isCurrent(): Promise<boolean>;
    apply(owner: ComponentUpdateOwner): Promise<{
        committed: boolean;
        restartRequired?: boolean;
    }>;
    /** Postcommit retry must only reconcile existing activation, not install again. */
    reconcile?(owner: ComponentUpdateOwner): Promise<{
        restartRequired?: boolean;
    }>;
}
export interface ComponentUpdateFailure extends Error {
    committed?: boolean;
    retryable?: boolean;
}
export class ComponentUpdates {
    private prepared: PreparedComponentUpdate[] = [];
    private state: ComponentUpdatesStatus = { running: false };
    private generation = 0;
    private context?: string;
    constructor(private readonly admission: ComponentUpdateAdmission, private readonly discover: () => Promise<PreparedComponentUpdate[]>, private readonly changed: () => void, private readonly restartPending: () => boolean, private readonly currentContext: () => string = () => '') { }
    get current(): ComponentUpdatesStatus {
        if (this.context !== undefined && this.context !== this.currentContext())
            return { running: this.state.running };
        return structuredClone(this.state);
    }
    async plan(): Promise<ComponentUpdatePlan> {
        this.admission.assertAllowed();
        const generation = ++this.generation;
        const context = this.currentContext();
        const prepared = await this.discover();
        this.admission.assertAllowed();
        if (context !== this.currentContext())
            throw Error('The component update context changed. Check again.');
        if (generation !== this.generation)
            throw Error('A newer component update check replaced this plan.');
        const ids = new Set<string>();
        for (const entry of prepared) {
            if (!entry.item.id || ids.has(entry.item.id))
                throw Error('Duplicate component update identity.');
            ids.add(entry.item.id);
        }
        // Launcher last, stable order within the runtime family set.
        const rank = { backend: 0, runtime: 1, launcher: 2 };
        this.prepared = [...prepared].sort((a, b) => rank[a.item.component] - rank[b.item.component]);
        const plan: ComponentUpdatePlan = { id: randomUUID(), createdAt: new Date().toISOString(), items: this.prepared.map(row => structuredClone(row.item)) };
        this.context = context;
        this.state = { running: false, plan };
        this.changed();
        return structuredClone(plan);
    }
    async apply(planId: string, retryItemId?: string): Promise<ComponentUpdateBatchResult> {
        // Synchronous reservation closes the first-await window for all child operations.
        const owner = this.admission.reserve();
        try {
            if (!this.state.plan || typeof planId !== 'string' || planId !== this.state.plan.id)
                throw Error('The component update plan is stale. Check again.');
            if (this.context !== this.currentContext())
                throw Error('The component update context changed. Check again.');
            const previous = this.state.result;
            if (retryItemId !== undefined && (!previous || !previous.items.some(row => row.id === retryItemId && row.retryable)))
                throw Error('This component cannot be retried.');
            if (retryItemId === undefined && previous)
                throw Error('This plan was already executed. Retry an eligible component or check again.');
            const results: ComponentUpdateItemResult[] = retryItemId ? structuredClone(previous!.items) : [];
            this.state.running = true;
            this.changed();
            let stopped = false;
            for (const entry of this.prepared) {
                if (retryItemId && entry.item.id !== retryItemId)
                    continue;
                let result: ComponentUpdateItemResult;
                const old = previous?.items.find(row => row.id === entry.item.id);
                if (stopped)
                    result = { id: entry.item.id, outcome: 'not-run', committed: false, retryable: false, message: 'An earlier component needs attention.' };
                else if (entry.item.state !== 'ready')
                    result = { id: entry.item.id, outcome: entry.item.state, committed: false, retryable: false, message: entry.item.reason };
                else {
                    this.state.phase = entry.item.label;
                    this.changed();
                    try {
                        this.admission.assertActivity(owner);
                        if (this.context !== this.currentContext())
                            throw Error('The component update context changed. Check again.');
                        // A committed retry compares the captured target in its reconcile adapter.
                        if (old?.committed) {
                            if (!entry.reconcile)
                                throw Object.assign(Error('Activation needs manual reconciliation.'), { committed: true });
                            await entry.reconcile(owner);
                            result = { id: entry.item.id, outcome: 'updated', committed: true, retryable: false };
                        }
                        else if (!await entry.isCurrent()) {
                            result = { id: entry.item.id, outcome: 'stale', committed: false, retryable: false, message: 'The installed component or update context changed. Check again.' };
                            stopped = true;
                        }
                        else {
                            this.admission.assertActivity(owner);
                            if (this.context !== this.currentContext())
                                throw Error('The component update context changed. Check again.');
                            const applied = await entry.apply(owner);
                            result = { id: entry.item.id, outcome: 'updated', committed: applied.committed, retryable: false };
                        }
                    }
                    catch (error) {
                        const committed = old?.committed === true || (error as ComponentUpdateFailure)?.committed === true;
                        result = { id: entry.item.id, outcome: committed ? 'committed-needs-attention' : 'failed-before-commit', committed,
                            retryable: (error as ComponentUpdateFailure)?.retryable !== false && (committed ? Boolean(entry.reconcile) : true), message: error instanceof Error ? error.message : String(error) };
                        stopped = true;
                    }
                }
                const index = results.findIndex(row => row.id === result.id);
                if (index < 0)
                    results.push(result);
                else
                    results[index] = result;
                this.state.result = { planId, items: structuredClone(results), restartRequired: this.restartPending() };
                this.changed();
            }
            this.state.result = { planId, items: results, restartRequired: this.restartPending() };
            return structuredClone(this.state.result);
        }
        finally {
            this.state.running = false;
            this.state.phase = undefined;
            this.admission.release(owner);
            this.changed();
        }
    }
}
