/**
 * @fileoverview Manages the lifecycle and location of all entities in the game world.
 *
 * ---
 *
 * ### Architectural Note: The Indirection Layer
 *
 * The `EntityManager` is the heart of the ECS's data lookup system. It doesn't store
 * any component data itself. Instead, it provides a crucial layer of indirection that
 * maps a sparse, stable `entityID` to the actual, densely packed component data stored
 * within an `Archetype`.
 *
 * This is achieved through a single primary sparse array:
 *
 * 1.  `this.entityArchetype`: An array where `entityArchetype[entityID]` returns the
 *     `archetypeId` (a small integer) the entity belongs to.
 *
 * The `Archetype` itself is now responsible for mapping the entity to its specific
 * location within a `Chunk`.
 *
 * **Example Lookup Flow:**
 *
 * `entityID` -> `EntityManager.entityArchetype[entityID]` -> `archetype` (which is an ID)
 * `archetype` -> `archetypeManager.archetypeEntityMaps[archetype]` -> `entityMap`
 * `entityMap.get(entityID)` -> `{ chunk, indexInChunk }`
 * ...then `chunk.componentArrays[typeID].x[indexInChunk]` to get the component data.
 */
const { systemManager } = await import(`${PATH_MANAGERS}/SystemManager/SystemManager.js`)

export class EntityManager {
	constructor() {
		this.nextEntityID = 1
		this.freeIDs = []
		this.activeEntities = new Set()
		this.entityArchetype = []
	}

	async init() {
		this.archetypeManager = (await import(`${PATH_MANAGERS}/ArchetypeManager/ArchetypeManager.js`)).archetypeManager
		this.componentManager = (await import(`${PATH_MANAGERS}/ComponentManager/ComponentManager.js`)).componentManager
		this.prefabManager = (await import(`${PATH_MANAGERS}/PrefabManager/PrefabManager.js`)).prefabManager
		this.systemManager = (await import(`${PATH_MANAGERS}/SystemManager/SystemManager.js`)).systemManager
	}

	createEntity() {
		return this._createEntityID()
	}

	createEntityWithComponentsByIds(componentIdMap) {
		if (componentIdMap.size === 0) {
			return this._createEntityID()
		}

		const entityID = this._createEntityID()
		const targetComponentTypeIDs = Array.from(componentIdMap.keys())
		const newArchetype = this.archetypeManager.getArchetype(targetComponentTypeIDs)

		this.entityArchetype[entityID] = newArchetype
		this.archetypeManager._addEntity(newArchetype, entityID, componentIdMap, this.systemManager.currentTick)

		return entityID
	}

    createEntityInArchetype(archetypeId, componentIdMap) {
        const entityID = this._createEntityID();
        this.entityArchetype[entityID] = archetypeId;
        this.archetypeManager._addEntity(archetypeId, entityID, componentIdMap, this.systemManager.currentTick);
        return entityID;
    }

	createEntitiesInArchetype(archetype, componentsDataMaps) {
		if (archetype === undefined || !Array.isArray(componentsDataMaps) || componentsDataMaps.length === 0) {
			return []
		}

		const entityIDs = []
		for (let i = 0; i < componentsDataMaps.length; i++) {
			entityIDs.push(this._createEntityID())
		}

		this.archetypeManager._addEntitiesBatch(archetype, entityIDs, componentsDataMaps, this.systemManager.currentTick)

		for (const entityID of entityIDs) {
			this.entityArchetype[entityID] = archetype
		}

		return entityIDs
	}

	createIdenticalEntitiesInArchetype(archetypeId, componentIdMap, count) {
		if (archetypeId === undefined || count <= 0) {
			return []
		}

		const entityIDs = []
		for (let i = 0; i < count; i++) {
			entityIDs.push(this._createEntityID())
		}

		this.archetypeManager._addIdenticalEntitiesBatch(archetypeId, entityIDs, componentIdMap, this.systemManager.currentTick)

		for (const entityID of entityIDs) {
			this.entityArchetype[entityID] = archetypeId
		}

		return entityIDs
	}

	setComponentData(entityID, componentTypeID, componentData) {
		if (!this.isEntityActive(entityID) || componentTypeID === undefined) return false

		const archetype = this.entityArchetype[entityID]
		if (archetype === undefined || !this.archetypeManager.hasComponentType(archetype, componentTypeID)) {
			return false
		}

		this.archetypeManager._setEntitiesComponents(
			archetype,
			[{ entityId: entityID, componentsToUpdate: new Map([[componentTypeID, componentData]]) }],
			this.systemManager.currentTick
		)
		return true
	}

	addComponent(entityID, componentTypeID, componentData) {
		if (!this.isEntityActive(entityID) || componentTypeID === undefined) return false

		const currentArchetype = this.entityArchetype[entityID]
		if (currentArchetype === undefined) {
			const newArchetype = this.archetypeManager.getArchetype([componentTypeID])
			this.entityArchetype[entityID] = newArchetype
			this.archetypeManager._addEntity(newArchetype, entityID, new Map([[componentTypeID, componentData]]), this.systemManager.currentTick)
			return true
		}

		if (this.archetypeManager.hasComponentType(currentArchetype, componentTypeID)) {
			return false
		}

		this._moveEntityToNewArchetype(entityID, currentArchetype, componentTypeID, componentData, true)
		return true
	}

	removeComponent(entityID, componentTypeID) {
		if (!this.isEntityActive(entityID) || componentTypeID === undefined) return false

		const currentArchetype = this.entityArchetype[entityID]
		if (
			currentArchetype === undefined ||
			!this.archetypeManager.hasComponentType(currentArchetype, componentTypeID)
		) {
			return false
		}

		this._moveEntityToNewArchetype(entityID, currentArchetype, componentTypeID, null, false)
		return true
	}

	hasComponent(entityID, componentTypeID) {
		if (!this.isEntityActive(entityID) || componentTypeID === undefined) return false

		const archetype = this.entityArchetype[entityID]
		return archetype !== undefined ? this.archetypeManager.hasComponentType(archetype, componentTypeID) : false
	}

	destroyEntity(entityID) {
		if (!this.activeEntities.has(entityID)) {
			return false
		}

		const archetype = this.entityArchetype[entityID]
		if (archetype !== undefined) {
			this.archetypeManager._removeEntity(archetype, entityID)
		}

		this.entityArchetype[entityID] = undefined
		this.activeEntities.delete(entityID)
		this.freeIDs.push(entityID)

		return true
	}

	destroyEntitiesInBatch(entityIDs) {
		if (!entityIDs || entityIDs.size === 0) {
			return true
		}

		const entitiesByArchetype = new Map()

		for (const entityId of entityIDs) {
			if (this.activeEntities.delete(entityId)) {
				this.freeIDs.push(entityId)
				const archetype = this.entityArchetype[entityId]
				if (archetype !== undefined) {
					if (!entitiesByArchetype.has(archetype)) {
						entitiesByArchetype.set(archetype, [])
					}
					entitiesByArchetype.get(archetype).push(entityId)
				}
				this.entityArchetype[entityId] = undefined
			}
		}

		for (const [archetype, ids] of entitiesByArchetype.entries()) {
			this.archetypeManager._removeEntitiesBatch(archetype, ids)
		}
		return true
	}

	destroyAllEntities() {
		if (this.archetypeManager) {
			this.archetypeManager.clearAll()
		}
		this.activeEntities.clear()
		this.freeIDs = []
		this.nextEntityID = 1
		this.entityArchetype = []
	}

	isEntityActive(entityID) {
		return this.activeEntities.has(entityID)
	}

	/**
	 * Gets the archetype ID for a given entity.
	 * @param {number} entityId - The ID of the entity.
	 * @returns {number | undefined} The archetype (ID), or undefined if the entity has no archetype.
	 */
	getArchetypeForEntity(entityId) {
		return this.entityArchetype[entityId]
	}

	_createEntityID() {
		const entityID = this.freeIDs.length > 0 ? this.freeIDs.pop() : this.nextEntityID++
		this.activeEntities.add(entityID)
		// Ensure the archetype array is large enough, initializing with undefined.
		if (entityID >= this.entityArchetype.length) {
			this.entityArchetype.length = entityID + 1
		}
		return entityID
	}

	_moveEntityToNewArchetype(entityID, currentArchetype, componentTypeID, data, isAdd) {
		const transitions = this.archetypeManager.archetypeTransitions[currentArchetype]
		const cacheKey = isAdd ? 'add' : 'remove'

		let targetArchetype = transitions[cacheKey][componentTypeID]

		if (targetArchetype === undefined) {
			const currentComponentTypeIDs = this.archetypeManager.archetypeComponentTypeIDs[currentArchetype]
			const newTypeIDs = isAdd
				? [...currentComponentTypeIDs, componentTypeID]
				: [...currentComponentTypeIDs].filter(id => id !== componentTypeID)
			targetArchetype = this.archetypeManager.getArchetype(newTypeIDs)
			transitions[cacheKey][componentTypeID] = targetArchetype
		}

		// This is a single-entity move, so we can use the batched move logic with a batch of 1.
		const componentsToAssign = isAdd ? new Map([[componentTypeID, data]]) : new Map()
		const moveMap = new Map([[currentArchetype, new Map([[targetArchetype, { entityIds: [entityID], componentsToAssignArrays: [componentsToAssign] }]])]])
		this.archetypeManager.moveEntitiesInBatch(moveMap)
		this.entityArchetype[entityID] = targetArchetype
	}
}

export const entityManager = new EntityManager()