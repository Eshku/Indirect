/**
 * A "hot" component that links an entity (e.g., an effect or projectile)
 * to its original owner/caster. This is an optimization to avoid traversing
 * a long chain of `Parent` components.
 */
export class Owner {
	static schema = {
		entityId: 'u32',
	}
	constructor({ entityId = 0 } = {}) {
		this.entityId = entityId
	}
}