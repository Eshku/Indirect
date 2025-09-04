const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { entityManager, componentManager, archetypeManager, sharedGroupManager } = theManager.getManagers()

/**
 * A high-level wrapper around an entity ID, providing convenient methods for **inspecting**
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
	 * Gets the entity's current Archetype ID.
	 * @returns {number | undefined} The Archetype ID.
	 */
	get archetypeId() {
		return entityManager.getArchetypeForEntity(this.id)
	}

	/**
	 * Checks if the entity is currently active in the world.
	 * @returns {boolean}
	 */
	get isActive() {
		return entityManager.isEntityActive(this.id)
	}

	/**
	 * Gets a list of all component names attached to this entity.
	 * A bit les cluttered to read through compared to whole object.
	 * @returns {string[]} An array of component names.
	 */
	get components() {
		if (!this.isActive) {
			console.warn(`Entity ${this.id} is not active.`)
			return []
		}
		const perEntityNames = new Set(componentManager.getComponentNamesForArchetype(this.archetypeId))

		// Also inspect shared components
		const componentData = this.data
		if (componentData) {
			for (const componentName in componentData) {
				const component = componentData[componentName]
				// A component has shared data if it has a groupId property after merging.
				if (component && component.hasOwnProperty('groupId')) {
					perEntityNames.add(componentName)
				}
			}
		}

		return [...perEntityNames].sort()
	}

	/**
	 * Retrieves an object containing all of the entity's components and their data.
	 * This is a self-contained implementation for debugging purposes.
	 * @returns {object | null} An object where keys are component names and values are their data, or null if the entity is inactive.
	 */
	get data() {
		if (!this.isActive) {
			console.warn(`Entity ${this.id} is not active.`)
			return null
		}

		const archetypeId = this.archetypeId
		if (archetypeId === undefined) {
			return {} // Should not happen for an active entity
		}

		// Access the archetype's component type IDs directly from the ArchetypeManager
		const componentTypeIDs = archetypeManager.archetypeComponentTypeIDs[archetypeId]
		if (!componentTypeIDs) {
			return {}
		}

		const allData = {}
		// Iterate over the component type IDs for this entity's archetype.
		// The browser console will typically sort these keys alphabetically for display.
		for (const typeId of componentTypeIDs) {
			const componentName = componentManager.getComponentNameByTypeID(typeId)
			const perEntityData = componentManager.readComponentData(this.id, typeId, archetypeId)

			if (perEntityData && perEntityData.hasOwnProperty('groupId')) {
				const groupId = perEntityData.groupId
				const sharedGroup = sharedGroupManager.groups[groupId]
				const sharedComponentData = sharedGroup ? sharedGroup[typeId] : null
				allData[componentName] = { ...perEntityData, ...sharedComponentData }
			} else {
				allData[componentName] = perEntityData
			}
		}
		return allData
	}

	/**
	 * Retrieves the fully reconstructed data for a specific component on this entity.
	 * @param {string} componentName - The string name of the component (e.g., "Position").
	 * @returns {object | undefined} The component data object, or undefined if the entity doesn't have the component or is inactive.
	 */
	get(componentName) {
		if (!this.isActive) {
			console.warn(`Entity ${this.id} is not active.`)
			return undefined
		}

		if (typeof componentName !== 'string' || !componentName) {
			console.error(`Entity.get() expects a non-empty string for componentName.`)
			return undefined
		}

		const componentTypeId = componentManager.getComponentTypeIDByName(componentName)
		if (componentTypeId === undefined) {
			// componentManager already warns if the name is not found.
			return undefined
		}

		// Verify the entity's archetype actually has this component before trying to read it.
		const archetypeId = this.archetypeId
		if (!archetypeManager.hasComponentType(archetypeId, componentTypeId)) {
			return undefined
		}

		const perEntityData = componentManager.readComponentData(this.id, componentTypeId, archetypeId)

		// Check for and merge shared data
		if (perEntityData && perEntityData.hasOwnProperty('groupId')) {
			const groupId = perEntityData.groupId
			const sharedGroup = sharedGroupManager.groups[groupId]
			const sharedComponentData = sharedGroup ? sharedGroup[componentTypeId] : null
			return { ...perEntityData, ...sharedComponentData }
		}

		return perEntityData
	}
}
