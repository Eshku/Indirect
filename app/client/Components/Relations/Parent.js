/**
 * A "hot" component that creates a parent-child relationship between entities.
 * This is fundamental to the relational ECS pattern, used to link effects
 * to their owners or to other effects.
 */
export class Parent {
	static schema = {
		entityId: 'u32',
	}
	constructor({ entityId = 0 } = {}) {
		this.entityId = entityId
	}
}

