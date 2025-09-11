/**
 * Manages the lifecycle and location of all entities in the game world.
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

	createIdenticalEntitiesInArchetype(archetypeId, payload, count) {
		if (archetypeId === undefined || count <= 0) {
			return []
		}

		const entityIDs = []
		for (let i = 0; i < count; i++) {
			entityIDs.push(this._createEntityID())
		}

		this.archetypeManager._addIdenticalEntitiesBatch(archetypeId, entityIDs, payload, this.systemManager.currentTick)

		for (const entityID of entityIDs) {
			this.entityArchetype[entityID] = archetypeId
		}

		return entityIDs
	}

	/**
	 * Creates a single entity from pre-unpacked SoA data.
	 * This is the direct-execution path for the new SoA-based `createEntity` command.
	 * @param {number} archetypeId The target archetype for the entity.
	 * @param {Map<number, {soaIndex: number}>} componentsToAssign A map of componentTypeID to its SoA index.
	 */
	createEntityFromSoA(archetypeId, componentsToAssign) {
		if (archetypeId === undefined) {
			return
		}
		const entityID = this._createEntityID()
		this.entityArchetype[entityID] = archetypeId
		this.archetypeManager._addEntityFromSoA(archetypeId, entityID, componentsToAssign, this.systemManager.currentTick)
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
		if (!entityIDs || entityIDs.size === 0) return true

		const entitiesByArchetype = new Map()

		for (const entityId of entityIDs) {
			// Use activeEntities.delete() as it returns true if the element was present
			if (this.activeEntities.delete(entityId)) {
				this.freeIDs.push(entityId)
				const archetype = this.entityArchetype[entityId]
				if (archetype !== undefined) {
					if (!entitiesByArchetype.has(archetype)) entitiesByArchetype.set(archetype, [])
					entitiesByArchetype.get(archetype).push(entityId)
				}
				// Important: Nullify the entity's archetype link
				this.entityArchetype[entityId] = undefined
			}
		}

		// Now, tell the ArchetypeManager to perform the batched removals.
		for (const [archetype, ids] of entitiesByArchetype.entries()) {
			this.archetypeManager._removeEntitiesBatch(archetype, ids)
		}
		return true
	}

	/**
	 * Destroys all entities matching a given query.
	 * This is the direct-execution path for the CommandBufferExecutor.
	 * @param {import('../QueryManager/Query.js').Query} query
	 */
	destroyEntitiesInQuery(query) {
		const chunksToDestroy = []
		for (const archetypeId of query.matchingArchetypeIds) {
			const chunks = this.archetypeManager.archetypeChunks[archetypeId]
			if (chunks) {
				chunksToDestroy.push(...chunks)
			}
		}
		this.destroyEntitiesInChunks(chunksToDestroy)
	}

	destroyEntitiesInChunks(chunks) {
		for (const chunk of chunks) {
			if (chunk.size === 0) continue

			for (let i = 0; i < chunk.size; i++) {
				const entityId = chunk.entities[i]
				this.activeEntities.delete(entityId)
				this.freeIDs.push(entityId)
				this.entityArchetype[entityId] = undefined
			}
			this.archetypeManager._removeEntitiesBatch(chunk.archetype, chunk.entities.subarray(0, chunk.size))
		}
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
}

export const entityManager = new EntityManager()
