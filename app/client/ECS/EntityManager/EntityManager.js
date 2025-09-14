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

export class EntityManager {
	constructor() {
		this.nextEntityID = 1
		this.freeIDs = []
		this.activeEntities = new Set()
		this.entityArchetype = []
	}

	async init() {
		const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
		const { prefabManager, archetypeManager, systemManager, componentManager } = theManager.getManagers()

		this.prefabManager = prefabManager
		this.archetypeManager = archetypeManager
		this.systemManager = systemManager
		this.componentManager = componentManager
	}

	createEntity() {
		return this._createEntityID()
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
	 * Creates a single entity from a pre-compiled binary SoA payload.
	 * This is the new, hyper-optimized "fast path" for single entity creation.
	 * @param {number} archetypeId The target archetype for the entity.
	 * @param {ArrayBuffer} binarySoAPayload The binary SoA-structured payload data.
	 * @param {number} currentTick The current game tick.
	 */
	createEntityFromBinarySoAPayload(archetypeId, binarySoAPayload, currentTick) {
		if (archetypeId === undefined) return
		const entityID = this._createEntityID()
		this.entityArchetype[entityID] = archetypeId
		this.archetypeManager.addEntityFromBinarySoAPayload(archetypeId, entityID, binarySoAPayload, currentTick)
		return entityID
	}

	/**
	 * Adds a component to an entity immediately. This is a slow, immediate-mode
	 * structural change. For performance, `commands.addComponent` should be used inside systems.
	 * @param {number} entityId The entity to modify.
	 * @param {number} componentTypeId The type ID of the component to add.
	 * @param {object} data The raw, interpreted data for the new component.
	 * @returns {boolean} True on success.
	 */
	addComponent(entityId, componentTypeId, data) {
		if (!this.isEntityActive(entityId)) return false

		const sourceArchetypeId = this.getArchetypeForEntity(entityId)
		if (this.archetypeManager.hasComponentType(sourceArchetypeId, componentTypeId)) {
			// The entity already has this component. This should be a `setComponentData` operation.
			// For now, we'll just return false to indicate the 'add' operation failed.
			console.warn(`EntityManager.addComponent: Entity ${entityId} already has component ${this.componentManager.getComponentNameByTypeID(componentTypeId)}.`)
			return false
		}

		const sourceArchetypeMask = this.archetypeManager.archetypeMasks[sourceArchetypeId]
		const targetArchetypeMask = sourceArchetypeMask | this.componentManager.componentBitFlags[componentTypeId]
		const targetArchetypeId = this.archetypeManager.getArchetypeByMask(targetArchetypeMask)

		const componentsToAssign = new Map([[componentTypeId, data]])

		return this._moveEntityToNewArchetype(entityId, sourceArchetypeId, targetArchetypeId, componentsToAssign)
	}

	removeComponent(entityId, componentTypeId) {
		if (!this.isEntityActive(entityId)) return false
		const sourceArchetypeId = this.getArchetypeForEntity(entityId)
		if (!this.archetypeManager.hasComponentType(sourceArchetypeId, componentTypeId)) return false
		const sourceArchetypeMask = this.archetypeManager.archetypeMasks[sourceArchetypeId]
		const targetArchetypeMask = sourceArchetypeMask & ~this.componentManager.componentBitFlags[componentTypeId]
		const targetArchetypeId = this.archetypeManager.getArchetypeByMask(targetArchetypeMask)
		return this._moveEntityToNewArchetype(entityId, sourceArchetypeId, targetArchetypeId, new Map())
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

	/**
	 * The internal workhorse for immediate-mode structural changes on a single entity.
	 * @param {number} entityId The entity to move.
	 * @param {number} sourceArchetypeId The entity's current archetype.
	 * @param {number} targetArchetypeId The entity's destination archetype.
	 * @param {Map<number, object>} componentsToAssign A map of new component data to assign.
	 * @returns {boolean} True on success.
	 * @private
	 */
	_moveEntityToNewArchetype(entityId, sourceArchetypeId, targetArchetypeId, componentsToAssign) {
		const sourceLocation = this.archetypeManager.archetypeEntityMaps[sourceArchetypeId]?.get(entityId)
		if (!sourceLocation) return false

		const { chunk: sourceChunk, indexInChunk: sourceIndex } = sourceLocation

		// 1. Allocate space in the target archetype
		const targetChunk = this.archetypeManager._findOrCreateChunk(targetArchetypeId)
		const targetIndex = targetChunk.addEntity(entityId)

		// 2. Update entity's primary location record
		this.entityArchetype[entityId] = targetArchetypeId
		this.archetypeManager.archetypeEntityMaps[targetArchetypeId].set(entityId, { chunk: targetChunk, indexInChunk: targetIndex })

		// 3. Copy existing component data
		const copyPlan = this.archetypeManager._getOrCreateCopyPlan(sourceArchetypeId, targetArchetypeId)
		for (const typeID of copyPlan.toCopy) {
			const sourceArrays = sourceChunk.componentArrays[typeID]
			const targetArrays = targetChunk.componentArrays[typeID]
			const info = this.componentManager.componentInfo[typeID]
			for (const propKey of info.propertyKeys) {
				if (targetArrays?.[propKey] && sourceArrays?.[propKey]) {
					targetArrays[propKey][targetIndex] = sourceArrays[propKey][sourceIndex]
				}
			}
		}

		// 4. Initialize new component data
		for (const [typeID, data] of componentsToAssign.entries()) {
			const dataView = new DataView(data.data) // data is the binary payload {typeID, data: ArrayBuffer}
			this.archetypeManager._writeComponentDataFromBuffer(targetChunk, targetIndex, typeID, dataView, 0)
		}

		// 5. Remove entity from the source archetype
		this.archetypeManager._removeEntity(sourceArchetypeId, entityId)

		return true
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
