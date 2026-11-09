/** Process-local ownership only. No renderer-supplied value can acquire ownership. */
export interface ComponentUpdateOwner {
    readonly identity: symbol;
}
export class ComponentUpdateAdmission {
    private owner?: ComponentUpdateOwner;
    constructor(private readonly assertActivityIdle: () => void) { }
    get busy(): boolean { return this.owner !== undefined; }
    assertAllowed(owner?: ComponentUpdateOwner): void {
        if (this.owner && owner !== this.owner)
            throw Error('Component updates are in progress.');
        if (owner && owner !== this.owner)
            throw Error('The component update reservation has expired.');
    }
    reserve(activityCheck: () => void = this.assertActivityIdle): ComponentUpdateOwner {
        this.assertAllowed();
        activityCheck();
        const owner = Object.freeze({ identity: Symbol('component-update') });
        this.owner = owner;
        return owner;
    }
    assertActivity(owner: ComponentUpdateOwner): void {
        this.assertAllowed(owner);
        this.assertActivityIdle();
    }
    release(owner: ComponentUpdateOwner): void {
        this.assertAllowed(owner);
        this.owner = undefined;
    }
}
