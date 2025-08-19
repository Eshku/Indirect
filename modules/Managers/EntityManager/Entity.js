const { entityManager } = await import(`${PATH_MANAGERS}/EntityManager/EntityManager.js`)
const { componentManager } = await import(`${PATH_MANAGERS}/ComponentManager/ComponentManager.js`)
const { archetypeManager } = await import(`${PATH_MANAGERS}/ArchetypeManager/ArchetypeManager.js`)

/**
 * A wrapper around an entity ID, providing convenient methods for **inspecting**
 * an entity's components and state from the developer console.
 *
 * IMPORTANT: This class is intended for debugging and console interaction ONLY.
 * It should NOT be used within performance-critical ECS systems. To modify entities
 * programmatically, use the methods on the global `ECS` object or the `commands`
 * object within a system.
 */
export class Entity {
	constructor(entityID) {
		/** @type {number} The ID of the wrapped entity. */
		this.id = entityID
	}

	/**
	 * Gets the entity's current archetype data object.
	 * @returns {object | undefined} The raw archetype data object.
	 */
	get archetype() {
		const archetypeId = entityManager.entityArchetype[this.id]
		return archetypeId !== undefined ? archetypeManager.getData(archetypeId) : undefined
	}

	/**
	 * Retrieves a component instance from the entity for inspection.
	 *
	 * For "Hot" (SoA) components, this constructs a new component instance from the
	 * underlying data. For "Cold" (AoS) components, this returns a direct reference.
	 *
	 * @param {string} componentName - The name of the component class.
	 * @returns {object | undefined} The component instance, or undefined.
	 */
	getComponent(componentName) {
		const ComponentClass = componentManager.getComponentClassByName(componentName)
		if (!ComponentClass) {
			console.warn(`Entity (ID: ${this.id}): Component class for "${componentName}" not found.`)
			return undefined
		}
		return entityManager.getComponent(this.id, ComponentClass)
	}

	/**
	 * Checks if the entity has a specific component.
	 * @param {string} componentName - The name of the component class.
	 * @returns {boolean} True if the entity has the component, false otherwise.
	 */
	hasComponent(componentName) {
		// This is the "slow path" for convenience, encapsulating the string-to-class lookup here.
		const ComponentClass = componentManager.getComponentClassByName(componentName)
		if (!ComponentClass) {
			console.log(`Component ${componentName} is not registered.`)
			return false
		}
		return entityManager.hasComponent(this.id, ComponentClass)
	}

	/**
	 * Gets an object detailing all components attached to this entity.
	 * This is the primary method for inspecting an entity's full state.
	 * @returns {object} An object where keys are component names and values are component instances.
	 */
	get components() {
		const currentArchetype = this.archetype
		if (!currentArchetype) {
			return {} // No archetype means no components
		}

		const componentInstances = {}
		const entityIndex = entityManager.entityIndexInArchetype[this.id]
		if (entityIndex === undefined) return {}

		for (const typeID of currentArchetype.componentTypeIDs) {
			const ComponentClass = componentManager.getComponentClassByTypeID(typeID)
			if (!ComponentClass) continue
			// Use the same logic as getComponent for consistency.
			// This is a debug/convenience method, so a little overhead is fine.
			const finalComponent = this.getComponent(ComponentClass.name)
			componentInstances[ComponentClass.name] = finalComponent
		}
		return componentInstances
	}
}
