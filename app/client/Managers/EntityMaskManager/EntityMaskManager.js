import { entityStore, MAX_CHUNKS, MASK_PARTS } from '../EntityManager/EntityManager.js'
import { DIRTY_HISTORY_LENGTH, componentInfo } from '../ComponentManager/ComponentSchema.js'
const { archetypeMatches } = await import(`../../Core/ArchetypeMatcher.js`)
import { radixSort } from '../../Core/Algorithms/RadixSorter.js'
const { getConstantsForProperty } = await import(`@managers/ComponentManager/ComponentConstants.js`)

/* Turns O(N) problems into O(K) problems (where K is the count of relevant entities). */

//! only useful when need to filter out small subset,
//! bypassing archetype churn,
//! where ~<10% entities needs to be processed.

//! Performance at scale needs to be revisited
//! custom bitmask-oriented implementation of a LSM Tree?

//! Make part of query as enabled:[componentID]? but then who "turns off the lights?" check each time we disable? nah.
//! so many fun things could be applied only for entity-level iterations, yet they do not allow chunk-level optimizations.

export class EntityMaskManager {
	async init(engine) {
		// --- Dynamically imported modules ---
		const defsModule = await import(`@managers/EntityMaskManager/MaskDefinitions.js`)
		this.maskDefinitions = defsModule.MaskDefinitions
		this.MASK_TYPE = defsModule.MASK_TYPE

		// --- Internal State ---
		this.maskSets = [] // Array of { name, type, allocationQuery, historyLength, masksByChunk }
		this.maskSetIdCounter = 0
		this.nameToId = new Map()
		this.chunksWithEventMasks = new Set()
		this.componentToEnableMaskId = new Map()
		this.componentToModifiedMaskId = new Map()
		this.initialStateMap = new Map() // Map<typeId, Map<propName, Map<value, maskId>>>

		// --- Pre-allocated structures for performance ---
		this._movesByChunkPair = new Map()
		this._moveBatchPool = []

		// --- Pre-allocated structures for batch moves ---
		this._batchMoveCapacity = 256
		this._batchMoveSortKeys = new BigUint64Array(this._batchMoveCapacity)
		this._batchMoveOldIndices = new Uint32Array(this._batchMoveCapacity)
		this._batchMoveNewIndices = new Uint32Array(this._batchMoveCapacity)
		this._tempBatchMoveSortKeys = new BigUint64Array(this._batchMoveCapacity)
		this._tempBatchMoveOldIndices = new Uint32Array(this._batchMoveCapacity)
		this._tempBatchMoveNewIndices = new Uint32Array(this._batchMoveCapacity)

		this._poolIndex = 0

		this.entityManager = engine.entityManager

		this.registerDeclarativeMasks()
	}

	registerDeclarativeMasks() {
		for (const name in this.maskDefinitions) {
			const def = this.maskDefinitions[name]
			let maskId
			if (def.type === this.MASK_TYPE.STATE) {
				maskId = this.createStateMask(name, def.rule)
			} else if (def.type === this.MASK_TYPE.EVENT) {
				// createEventMask has a default for historyLength, so this is safe.
				maskId = this.createEventMask(name, def.rule, def.historyLength)
			}

			// --- NEW: Handle declarative enableable/trackable masks ---
			if (def.isEnableableFor !== undefined) {
				this.componentToEnableMaskId.set(def.isEnableableFor, maskId)
			}
			if (def.isModifiedFor !== undefined) {
				this.componentToModifiedMaskId.set(def.isModifiedFor, maskId)
			}

			// --- REFACTORED: Handle automatic mask binding on value change ---
			if (def.autoMaskOnValue) {
				const { component, property } = def.autoMaskOnValue
				let { value } = def.autoMaskOnValue

				// --- NEW: Auto-derive value if not provided ---
				if (value === undefined) {
					// Convention: mask name 'isSpawning' -> enum key 'SPAWNING'
					const enumKey = name.startsWith('is') ? name.substring(2).toUpperCase() : name.toUpperCase()
					const constants = getConstantsForProperty(component, property)
					if (constants && constants[enumKey] !== undefined) {
						value = constants[enumKey]
					} else {
						console.warn(`[EntityMaskManager] Could not auto-derive value for autoMaskOnValue on mask "${name}". No constant found for key "${enumKey}".`)
						continue // Skip adding to the binding map
					}
				}

				if (!this.initialStateMap.has(component)) {
					this.initialStateMap.set(component, new Map())
				}
				const propMap = this.initialStateMap.get(component)
				if (!propMap.has(property)) {
					propMap.set(property, new Map())
				}
				const valueMap = propMap.get(property)
				valueMap.set(value, maskId)
			}
		}
	}

	_resizeBatchMoveArrays(requiredCapacity) {
		const oldCapacity = this._batchMoveCapacity
		const newCapacity = Math.max(oldCapacity * 2, requiredCapacity)
		console.warn(`[EntityMaskManager] Resizing batch move arrays from ${oldCapacity} to ${newCapacity}.`)
		this._batchMoveCapacity = newCapacity

		const newSortKeys = new BigUint64Array(newCapacity)
		newSortKeys.set(this._batchMoveSortKeys)
		this._batchMoveSortKeys = newSortKeys

		const newOldIndices = new Uint32Array(newCapacity)
		newOldIndices.set(this._batchMoveOldIndices)
		this._batchMoveOldIndices = newOldIndices

		const newNewIndices = new Uint32Array(newCapacity)
		newNewIndices.set(this._batchMoveNewIndices)
		this._batchMoveNewIndices = newNewIndices

		this._tempBatchMoveSortKeys = new BigUint64Array(newCapacity)
		this._tempBatchMoveOldIndices = new Uint32Array(newCapacity)
		this._tempBatchMoveNewIndices = new Uint32Array(newCapacity)
	}

	// =================================================================
	// PUBLIC API - HIGH LEVEL HELPERS
	// =================================================================

	getEnabledMask(componentTypeId) {
		// Mask must have been registered at startup.
		// If this returns undefined, it means the component was not declared with
		// `meta: { isEnableable: true }` in its schema. The calling function will throw
		// a native error, which is the desired behavior.
		return this.componentToEnableMaskId.get(componentTypeId)
	}

	enableComponent(chunkId, indexInChunk, componentTypeId) {
		const maskId = this.getEnabledMask(componentTypeId)
		this.setBit(maskId, chunkId, indexInChunk)
	}

	enableComponentById(entityId, componentTypeId) {
		const maskId = this.getEnabledMask(componentTypeId)
		this.setBitById(maskId, entityId)
	}

	disableComponent(chunkId, indexInChunk, componentTypeId) {
		const maskId = this.getEnabledMask(componentTypeId)
		this.clearBit(maskId, chunkId, indexInChunk)
	}

	disableComponentById(entityId, componentTypeId) {
		const maskId = this.getEnabledMask(componentTypeId)
		this.clearBitById(maskId, entityId)
	}

	getEnabled(chunkId, componentTypeId, outBuffer) {
		const maskId = this.componentToEnableMaskId.get(componentTypeId)
		// If maskId is undefined here, it means the component was not declared as
		// `isEnableable`. The subsequent call to getIndicesFromMask will throw a native
		// TypeError, which is the desired behavior.
		return this.getIndicesFromMask(maskId, chunkId, outBuffer)
	}

	getDirtyMask(componentTypeId) {
		// This is now a simple getter. The mask must have been registered at startup.
		// If this returns undefined, it means the component was not declared with
		// `meta: { isTrackable: true }` in its schema. The calling function will throw
		// a native error, which is the desired behavior.
		return this.componentToModifiedMaskId.get(componentTypeId)
	}

	maskDirty(chunkId, indexInChunk, componentTypeId, tick) {
		// If the component is not trackable, getDirtyMask will return undefined,
		// and the subsequent call to fireEvent will throw a native TypeError.
		const maskId = this.getDirtyMask(componentTypeId)
		this.fireEvent(maskId, chunkId, indexInChunk, tick)
	}

	maskDirtyById(entityId, componentTypeId, tick) {
		// If the component is not trackable, getDirtyMask will return undefined,
		// and the subsequent call to fireEventById will throw a native TypeError.
		const maskId = this.getDirtyMask(componentTypeId)
		this.fireEventById(maskId, entityId, tick)
	}

	markEntitiesDirty(chunkId, indexInChunk, componentTypeIds, tick) {
		for (const componentTypeId of componentTypeIds) {
			this.maskDirty(chunkId, indexInChunk, componentTypeId, tick)
		}
	}

	markEntitiesDirtyById(entityId, componentTypeIds, tick) {
		if (Array.isArray(entityId)) {
			for (const id of entityId) {
				this.markEntitiesDirtyById(id, componentTypeIds, tick)
			}
		} else {
			const location = this.entityManager.getEntityLocation(entityId)
			this.markEntitiesDirty(location.chunkId, location.indexInChunk, componentTypeIds, tick)
		}
	}

	markEntitiesDirtyBatch(entityIds, trackableIds, tick) {
		for (let i = 0; i < entityIds.length; i++) {
			const entityId = entityIds[i]
			const ids = trackableIds[i] // Assuming trackableIds is an array of arrays
			const location = this.entityManager.getEntityLocation(entityId)
			if (!location) continue

			for (const componentTypeId of ids) {
				const maskId = this.getDirtyMask(componentTypeId)
				if (maskId !== undefined) {
					this.fireEvent(maskId, location.chunkId, location.indexInChunk, tick)
				}
			}
		}
	}

	markEntitiesDirtyBatchSoA(entityIds, packedIdsAndCounts, tick) {
		let packedIndex = 0
		for (let i = 0; i < entityIds.length; i++) {
			const entityId = entityIds[i]
			const location = this.entityManager.getEntityLocation(entityId)
			if (!location) {
				// Skip the trackable IDs for this entity
				const count = packedIdsAndCounts[packedIndex]
				packedIndex += count + 1
				continue
			}
			const trackableCount = packedIdsAndCounts[packedIndex++]

			for (let j = 0; j < trackableCount; j++) {
				const componentTypeId = packedIdsAndCounts[packedIndex++]
				const maskId = this.getDirtyMask(componentTypeId)
				if (maskId !== undefined) {
					this.fireEvent(maskId, location.chunkId, location.indexInChunk, tick)
				}
			}
		}
	}

	getDirty(chunkId, componentTypeId, lastTick, currentTick, outBuffer) {
		const maskId = this.getDirtyMask(componentTypeId)
		// If maskId is undefined, the component was not declared as `isTrackable`.
		// The subsequent call to getEventsSince will throw a native TypeError.
		return this.getEventsSince(maskId, chunkId, lastTick, currentTick, outBuffer)
	}

	// =================================================================
	// PUBLIC API - GENERIC (for advanced use)
	// =================================================================

	/**
	 * Retrieves read-only information about a mask set.
	 * @param {number} maskSetId The ID of the mask set.
	 * @returns {{name: string, type: MASK_TYPE, historyLength?: number} | undefined}
	 */
	getMaskSetInfo(maskSetId) {
		const maskSet = this.maskSets[maskSetId]
		if (!maskSet) {
			return undefined
		}
		return {
			name: maskSet.name,
			type: maskSet.type,
			historyLength: maskSet.historyLength,
		}
	}

	getMaskIdByName(name) {
		return this.nameToId.get(name)
	}

	createStateMask(name, allocationRuleDef) {
		if (this.nameToId.has(name)) {
			return this.nameToId.get(name)
		}
		if (!name || !allocationRuleDef) {
			throw new Error('[EntityMaskManager] A name and allocationRuleDef are required to create a state mask set.')
		}

		const maskSetId = this.maskSetIdCounter++
		this.maskSets[maskSetId] = {
			name,
			type: this.MASK_TYPE.STATE,
			allocationRule: this._buildAllocationRule(allocationRuleDef),
			masksByChunk: new Array(MAX_CHUNKS), // Will hold Uint32Array views
		}
		this.nameToId.set(name, maskSetId)

		// No back-filling. All allocation is now reactive via handleChunkCreated.
		return maskSetId
	}

	createEventMask(name, allocationRuleDef, historyLength = DIRTY_HISTORY_LENGTH) {
		if (this.nameToId.has(name)) {
			return this.nameToId.get(name)
		}
		if (!name || !allocationRuleDef) {
			throw new Error('[EntityMaskManager] A name and allocationRuleDef are required to create an event mask set.')
		}

		const maskSetId = this.maskSetIdCounter++
		this.maskSets[maskSetId] = {
			name,
			type: this.MASK_TYPE.EVENT,
			allocationRule: this._buildAllocationRule(allocationRuleDef),
			historyLength,
			masksByChunk: new Array(MAX_CHUNKS), // Will hold Uint32Array views
		}
		this.nameToId.set(name, maskSetId)

		return maskSetId
	}

	// --- Write API (Immediate & Atomic) ---

	setBit(maskSetId, chunkId, indexInChunk) {
		const maskSet = this.maskSets[maskSetId]
		// If `maskSet` is undefined, it's likely because `maskSetId` was undefined.
		// This can happen if getEnabledMask() was called for a component that was not
		// declared as `isEnableable` in its schema. The following line will then throw
		// a native TypeError, which is the desired behavior to signal a developer error.
		if (maskSet.type !== this.MASK_TYPE.STATE) {
			throw new Error(`[EntityMaskManager] setBit called on a non-state mask set "${maskSet.name}".`)
		}

		const mask = maskSet.masksByChunk[chunkId]
		// If `mask` is undefined, it means this mask was not allocated for this chunk.
		// This is a developer error, either because the allocation rule is wrong, or a stale
		// chunkId is being used. The following line will intentionally throw a TypeError,
		// which is the desired behavior to catch such errors. A silent failure would hide bugs.

		const wordIndex = indexInChunk >>> 5
		const bitInWord = 1 << (indexInChunk & 31)
		Atomics.or(mask, wordIndex, bitInWord)
	}

	setBitById(maskSetId, entityId) {
		const location = this.entityManager.getEntityLocation(entityId)

		this.setBit(maskSetId, location.chunkId, location.indexInChunk)
	}

	clearBit(maskSetId, chunkId, indexInChunk) {
		const maskSet = this.maskSets[maskSetId]
		// If `maskSet` is undefined, it's likely because `maskSetId` was undefined.
		// This can happen if getEnabledMask() was called for a component that was not
		// declared as `isEnableable` in its schema. The following line will then throw
		// a native TypeError, which is the desired behavior to signal a developer error.
		if (maskSet.type !== this.MASK_TYPE.STATE) {
			throw new Error(`[EntityMaskManager] clearBit called on a non-state mask set "${maskSet.name}".`)
		}

		const mask = maskSet.masksByChunk[chunkId]
		// If `mask` is undefined, it means this mask was not allocated for this chunk.
		// This is a developer error, either because the allocation rule is wrong, or a stale
		// chunkId is being used. The following line will intentionally throw a TypeError,
		// which is the desired behavior to catch such errors. A silent failure would hide bugs.

		const wordIndex = indexInChunk >>> 5
		const bitInWord = 1 << (indexInChunk & 31)
		Atomics.and(mask, wordIndex, ~bitInWord)
	}

	clearBitById(maskSetId, entityId) {
		const location = this.entityManager.getEntityLocation(entityId)

		this.clearBit(maskSetId, location.chunkId, location.indexInChunk)
	}

	fireEvent(maskSetId, chunkId, indexInChunk, tick) {
		const maskSet = this.maskSets[maskSetId]
		// If `maskSet` is undefined, it's likely because `maskSetId` was undefined.
		// This can happen if getDirtyMask() was called for a component that was not
		// declared as `isTrackable` in its schema. The following line will then throw
		// a native TypeError, which is the desired behavior to signal a developer error.
		if (maskSet.type !== this.MASK_TYPE.EVENT) {
			throw new Error(`[EntityMaskManager] fireEvent called on a non-event mask set "${maskSet.name}".`)
		}

		const eventMasks = maskSet.masksByChunk[chunkId]
		// If `eventMasks` is undefined, it means the mask was not allocated for this chunk.
		// This can happen if we are operating on a stale chunkId that has been destroyed
		// and recycled for an archetype that doesn't match the mask's allocation rule. This is a
		// a developer error. The following line will intentionally throw a TypeError, which is
		// the desired behavior to catch such errors. A silent failure would hide bugs.

		// NEW "Entity-Major" Logic: Atomically OR the bit for the given tick into the entity's history integer.
		const historyBit = 1n << BigInt(tick % maskSet.historyLength)
		Atomics.or(eventMasks, indexInChunk, historyBit)
	}

	fireEventById(maskSetId, entityId, tick) {
		const location = this.entityManager.getEntityLocation(entityId)

		this.fireEvent(maskSetId, location.chunkId, location.indexInChunk, tick)
	}

	isBitSet(maskSetId, chunkId, indexInChunk) {
		const maskSet = this.maskSets[maskSetId]
		// If `maskSet` is undefined, it's likely because `maskSetId` was undefined.
		// This can happen if getEnabledMask() was called for a component that was not
		// declared as `isEnableable` in its schema. The following line will then throw
		// a native TypeError, which is the desired behavior to signal a developer error.
		if (maskSet.type !== this.MASK_TYPE.STATE) {
			throw new Error(`[EntityMaskManager] isBitSet called on a non-state mask set "${maskSet.name}".`)
		}

		const mask = maskSet.masksByChunk[chunkId]
		// If `mask` is undefined, it means this mask was not allocated for this chunk.
		// This is a developer error. The following line will intentionally throw a TypeError.
		// A silent `return false` was removed because it can hide bugs where a system
		// operates on a stale entity location.

		const wordIndex = indexInChunk >>> 5
		const bitInWord = 1 << (indexInChunk & 31)
		// Use Atomics.load for thread-safe reading from the SharedArrayBuffer.
		const word = Atomics.load(mask, wordIndex)
		return (word & bitInWord) !== 0
	}

	// --- Query API ---

	getIndicesFromMask(maskSetId, chunkId, outBuffer) {
		const maskSet = this.maskSets[maskSetId]
		// If `maskSet` is undefined, it's likely because `maskSetId` was undefined.
		// This can happen if getEnabled() was called for a component that was not
		// declared as `isEnableable` in its schema. The following line will then throw
		// a native TypeError, which is the desired behavior to signal a developer error.
		const mask = maskSet.masksByChunk[chunkId]
		// If `mask` is undefined, it means this mask was not allocated for this chunk.
		// This is a developer error. The following line will intentionally throw a TypeError.
		// A silent `return 0` was removed because it can hide bugs.

		const size = entityStore.chunkSizes[chunkId]
		let count = 0
		const numWords = Math.ceil(size / 32)

		for (let i = 0; i < numWords; i++) {
			let bits = Atomics.load(mask, i)
			if (bits === 0) continue

			const offset = i << 5
			while (bits !== 0) {
				const t = bits & -bits
				const indexInWord = 31 - Math.clz32(t)
				const entityIndex = offset | indexInWord

				if (entityIndex >= size) break

				outBuffer[count++] = entityIndex
				bits ^= t
			}
		}
		return count
	}

	getEventsSince(maskSetId, chunkId, lastTick, currentTick, outBuffer) {
		const maskSet = this.maskSets[maskSetId]
		// If `maskSet` is undefined, it's likely because `maskSetId` was undefined.
		// This can happen if getDirty() was called for a component that was not
		// declared as `isTrackable` in its schema. The following line will then throw
		// a native TypeError, which is the desired behavior to signal a developer error.
		const eventMasks = maskSet.masksByChunk[chunkId]
		// If `eventMasks` is undefined, it means this mask was not allocated for this chunk.
		// This is a developer error. The following line will intentionally throw a TypeError.
		// A silent `return 0` was removed because it can hide bugs.

		// NEW "Entity-Major" Logic
		const size = entityStore.chunkSizes[chunkId]
		const historyLength = maskSet.historyLength
		let count = 0

		// 1. Create a bitmask representing the tick range.
		let tickMask = 0n
		const tickDelta = currentTick - lastTick
		const startTick = tickDelta >= historyLength ? currentTick - historyLength + 1 : lastTick + 1

		for (let tick = startTick; tick <= currentTick; tick++) {
			tickMask |= 1n << BigInt(tick % historyLength)
		}

		if (tickMask === 0n) return 0

		// 2. Iterate through entities and check their history against the mask.
		for (let i = 0; i < size; i++) {
			const entityHistory = Atomics.load(eventMasks, i)
			if ((entityHistory & tickMask) !== 0n) {
				outBuffer[count++] = i
			}
		}
		return count
	}

	isComponentEnabled(chunkId, indexInChunk, componentTypeId) {
		const maskId = this.componentToEnableMaskId.get(componentTypeId)
		// If maskId is undefined, the component was not declared as `isEnableable`.
		// The subsequent call to isBitSet will receive an undefined maskId and throw
		// a native TypeError, which is the desired behavior to signal a developer error.
		return this.isBitSet(maskId, chunkId, indexInChunk)
	}

	// =================================================================
	// INTERNAL & LIFECYCLE METHODS
	// =================================================================

	/**
	 * Resets the BitmaskManager's internal state. Primarily used for test isolation.
	 * This will clear all registered mask sets.
	 */
	clear() {
		this.maskSets = []
		this.maskSetIdCounter = 0
		this.nameToId.clear()
		this.chunksWithEventMasks.clear()
		this.componentToEnableMaskId.clear()
		this.componentToModifiedMaskId.clear()
		this.initialStateMap.clear()
	}

	performMaintenance(chunkId, currentTick) {
		for (let maskSetId = 0; maskSetId < this.maskSetIdCounter; maskSetId++) {
			const maskSet = this.maskSets[maskSetId]
			if (maskSet.type !== this.MASK_TYPE.EVENT) continue

			const eventMasks = maskSet.masksByChunk[chunkId]
			if (!eventMasks) continue

			// NEW "Entity-Major" Logic: Clear the bit for the upcoming tick across all entities.
			const maskHistoryLength = maskSet.historyLength
			const tickToClear = currentTick + 1
			const bitToClear = 1n << BigInt(tickToClear % maskHistoryLength)
			const clearMask = ~bitToClear

			// Iterate through all entities in the chunk and clear the bit.
			// This is a fast, linear operation.
			const size = entityStore.chunkSizes[chunkId]
			for (let i = 0; i < size; i++) {
				Atomics.and(eventMasks, i, clearMask)
			}
		}
	}

	getChunksWithEventMasks() {
		return this.chunksWithEventMasks
	}

	handleChunkCreated = (chunkId, archetypeId) => {
		for (let maskSetId = 0; maskSetId < this.maskSetIdCounter; maskSetId++) {
			const maskSet = this.maskSets[maskSetId]
			if (archetypeMatches(archetypeId, maskSet.allocationRule)) {
				this._allocateMaskForChunk(maskSet, chunkId)
			}
		}
	}

	_buildAllocationRule(ruleDef) {
		const rule = {}
		if (ruleDef.with) {
			rule.with = new BigUint64Array(MASK_PARTS)
			for (const id of ruleDef.with) {

				const partIndex = Math.floor(id / 64)
				rule.with[partIndex] |= 1n << BigInt(id % 64)
			}
		}
		if (ruleDef.without) {
			rule.without = new BigUint64Array(MASK_PARTS)
			for (const id of ruleDef.without) {
				const partIndex = Math.floor(id / 64)
				rule.without[partIndex] |= 1n << BigInt(id % 64)
			}
		}
		return rule
	}

	_allocateMaskForChunk(maskSet, chunkId) {
		const capacity = entityStore.chunkCapacities[chunkId]

		if (maskSet.type === this.MASK_TYPE.STATE) {
			const words = Math.ceil(capacity / 32)
			const buffer = new SharedArrayBuffer(words * 4)
			maskSet.masksByChunk[chunkId] = new Uint32Array(buffer)
		} else if (maskSet.type === this.MASK_TYPE.EVENT) {
			// NEW "Entity-Major" Layout: One u64 per entity to hold its history.
			const buffer = new SharedArrayBuffer(capacity * BigUint64Array.BYTES_PER_ELEMENT)
			maskSet.masksByChunk[chunkId] = new BigUint64Array(buffer)
			this.chunksWithEventMasks.add(chunkId)
		}
	}

	handleChunkDestroyed = chunkId => {
		for (let maskSetId = 0; maskSetId < this.maskSetIdCounter; maskSetId++) {
			// Just dereference buffer for GC.
			this.maskSets[maskSetId].masksByChunk[chunkId] = undefined
		}
		this.chunksWithEventMasks.delete(chunkId)
	}

	/**
	 * Handles mask updates when a single entity moves between chunks.
	 * This is the non-batching, allocation-free version for single entity moves.
	 * @param {object} oldLocation The entity's old location { chunkId, indexInChunk }.
	 * @param {object} newLocation The entity's new location { chunkId, indexInChunk }.
	 */
	handleEntityMoved(oldLocation, newLocation) {
		const oldChunkId = oldLocation.chunkId
		const newChunkId = newLocation.chunkId
		const oldIndex = oldLocation.indexInChunk
		const newIndex = newLocation.indexInChunk

		for (let maskSetId = 0; maskSetId < this.maskSetIdCounter; maskSetId++) {
			const maskSet = this.maskSets[maskSetId]
			const oldMask = maskSet.masksByChunk[oldChunkId]
			const newMask = maskSet.masksByChunk[newChunkId]

			if (!newMask) continue

			if (maskSet.type === this.MASK_TYPE.STATE) {
				let isSet = false
				if (oldMask) {
					const oldWordIndex = oldIndex >>> 5
					const oldBitInWord = 1 << (oldIndex & 31)
					isSet = (Atomics.load(oldMask, oldWordIndex) & oldBitInWord) !== 0
					Atomics.and(oldMask, oldWordIndex, ~oldBitInWord)
				}

				const newWordIndex = newIndex >>> 5
				const newBitInWord = 1 << (newIndex & 31)
				if (isSet) {
					Atomics.or(newMask, newWordIndex, newBitInWord)
				} else {
					Atomics.and(newMask, newWordIndex, ~newBitInWord)
				}
			} else if (maskSet.type === this.MASK_TYPE.EVENT) {
				// NEW "Entity-Major" Logic: Simple history copy.
				let history = 0n
				if (oldMask) {
					// Load the entire 64-bit history for the entity.
					history = Atomics.load(oldMask, oldIndex)
					// Clear the history at the old location.
					Atomics.store(oldMask, oldIndex, 0n)
				} else {
					// If there was no old mask, history is implicitly 0.
				}
				// Store the (potentially zero) history at the new location.
				Atomics.store(newMask, newIndex, history)
			}
		}
	}

	/**
	 * Handles mask updates when a batch of entities moves between chunks.
	 * @param {Uint32Array} oldPackedLocations
	 * @param {Uint32Array} oldIndices
	 * @param {Uint32Array} newPackedLocations
	 * @param {Uint32Array} newIndices
	 * @param {number} count
	 * @private
	 */
	handleEntitiesMovedInBatch(oldPackedLocations, oldIndicesInChunk, newPackedLocations, newIndicesInChunk, count) {
		if (count === 0) return
		if (count > this._batchMoveCapacity) this._resizeBatchMoveArrays(count)

		// 1. Populate sortable scratch arrays.
		for (let i = 0; i < count; i++) {
			const oldChunkId = oldPackedLocations[i] & 0xffff
			const newChunkId = newPackedLocations[i] & 0xffff
			const sortKey = (BigInt(oldChunkId) << 32n) | BigInt(newChunkId)

			this._batchMoveSortKeys[i] = sortKey
			this._batchMoveOldIndices[i] = oldIndicesInChunk[i]
			this._batchMoveNewIndices[i] = newIndicesInChunk[i]
		}

		// 2. Radix sort all scratch arrays based on the composite sort key.
		radixSort(
			this._batchMoveSortKeys.subarray(0, count),
			this._batchMoveOldIndices.subarray(0, count),
			this._batchMoveNewIndices.subarray(0, count),
			null,
			null,
			this._tempBatchMoveSortKeys.subarray(0, count),
			this._tempBatchMoveOldIndices.subarray(0, count),
			this._tempBatchMoveNewIndices.subarray(0, count),
			null,
			null,
		)

		// 3. Iterate through the sorted arrays and process one chunk-pair-batch at a time.
		let i = 0
		while (i < count) {
			const sortKey = this._batchMoveSortKeys[i]
			const oldChunkId = Number(sortKey >> 32n)
			const newChunkId = Number(sortKey & 0xffffffffn)

			// Find the end of the current batch.
			let batchEnd = i + 1
			while (batchEnd < count && this._batchMoveSortKeys[batchEnd] === sortKey) {
				batchEnd++
			}

			// Now, for this specific chunk-to-chunk move, iterate through all mask sets.
			for (let maskSetId = 0; maskSetId < this.maskSetIdCounter; maskSetId++) {
				const maskSet = this.maskSets[maskSetId]
				const oldMask = maskSet.masksByChunk[oldChunkId]
				const newMask = maskSet.masksByChunk[newChunkId]

				if (!newMask) continue

				if (maskSet.type === this.MASK_TYPE.STATE) {
					for (let j = i; j < batchEnd; j++) {
						const oldIndex = this._batchMoveOldIndices[j]
						const newIndex = this._batchMoveNewIndices[j]
						let isSet = false
						if (oldMask) {
							const oldWordIndex = oldIndex >>> 5,
								oldBitInWord = 1 << (oldIndex & 31)
							isSet = (Atomics.load(oldMask, oldWordIndex) & oldBitInWord) !== 0
							Atomics.and(oldMask, oldWordIndex, ~oldBitInWord)
						}
						const newWordIndex = newIndex >>> 5,
							newBitInWord = 1 << (newIndex & 31)
						if (isSet) Atomics.or(newMask, newWordIndex, newBitInWord)
						else Atomics.and(newMask, newWordIndex, ~newBitInWord)
					}
				} else if (maskSet.type === this.MASK_TYPE.EVENT) {
					// NEW "Entity-Major" Bulk Copy: This is now a simple, fast loop.
					for (let j = i; j < batchEnd; j++) {
						const oldIndex = this._batchMoveOldIndices[j]
						const newIndex = this._batchMoveNewIndices[j]
						let history = 0n
						if (oldMask) {
							// Load the entire 64-bit history for the entity.
							history = Atomics.load(oldMask, oldIndex)
							// Clear the history at the old location.
							Atomics.store(oldMask, oldIndex, 0n)
						}
						// Store the (potentially zero) history at the new location.
						Atomics.store(newMask, newIndex, history)
					}
				}
			}
			i = batchEnd
		}
	}

	handleEntitiesMoved = moveBatch => {
		if (moveBatch.entityIds.length === 0) return

		// 1. Group moves by their source and destination chunks. This is a huge optimization
		// that allows us to process entities moving between the same two chunks in a batch.
		// We reuse a class-level map and a pool of batch objects to eliminate allocations.
		const movesByChunkPair = this._movesByChunkPair
		movesByChunkPair.clear()
		this._poolIndex = 0

		for (let i = 0; i < moveBatch.entityIds.length; i++) {
			const oldLocation = moveBatch.oldLocations[i]
			const newLocation = moveBatch.newLocations[i]
			// Bit-pack old and new chunk IDs into a single 32-bit integer key.
			// This is allocation-free and much faster than string manipulation.
			const key = (oldLocation.chunkId << 16) | newLocation.chunkId

			let batch = movesByChunkPair.get(key)
			if (!batch) {
				batch = this._getBatchFromPool()
				movesByChunkPair.set(key, batch)
			}
			batch.oldIndices.push(oldLocation.indexInChunk)
			batch.newIndices.push(newLocation.indexInChunk)
		}

		// 2. Process the grouped moves.
		for (const [key, { oldIndices, newIndices }] of movesByChunkPair.entries()) {
			// Unpack the chunk IDs from the numeric key.
			const oldChunkId = key >> 16
			const newChunkId = key & 0xffff

			// Now, for this specific chunk-to-chunk move, iterate through all mask sets.
			for (let maskSetId = 0; maskSetId < this.maskSetIdCounter; maskSetId++) {
				const maskSet = this.maskSets[maskSetId]
				const oldMask = maskSet.masksByChunk[oldChunkId]
				const newMask = maskSet.masksByChunk[newChunkId]

				// If the destination chunk doesn't have this mask, there's nothing to do.
				if (!newMask) continue

				if (maskSet.type === this.MASK_TYPE.STATE) {
					for (let i = 0; i < oldIndices.length; i++) {
						const oldIndex = oldIndices[i]
						const newIndex = newIndices[i]

						let isSet = false
						// Only read from oldMask if it exists.
						if (oldMask) {
							const oldWordIndex = oldIndex >>> 5
							const oldBitInWord = 1 << (oldIndex & 31)
							isSet = (Atomics.load(oldMask, oldWordIndex) & oldBitInWord) !== 0
							// After reading, clear the bit at the old location. This is crucial to prevent
							// stale state if the slot is reused by a swap or a new entity.
							Atomics.and(oldMask, oldWordIndex, ~oldBitInWord)
						}
						// If oldMask doesn't exist, isSet remains false. This is correct, as the
						// entity is moving into an archetype that has the mask, so its state for
						// this mask should be initialized to 0 (cleared).

						// Now, write the correct state to the new location.
						const newWordIndex = newIndex >>> 5
						const newBitInWord = 1 << (newIndex & 31)
						if (isSet) {
							Atomics.or(newMask, newWordIndex, newBitInWord)
						} else {
							Atomics.and(newMask, newWordIndex, ~newBitInWord)
						}
					}
				} else if (maskSet.type === this.MASK_TYPE.EVENT) {
					// NEW "Entity-Major" Bulk Copy
					for (let i = 0; i < oldIndices.length; i++) {
						const oldIndex = oldIndices[i]
						const newIndex = newIndices[i]
						let history = 0n
						if (oldMask) {
							history = Atomics.load(oldMask, oldIndex)
							Atomics.store(oldMask, oldIndex, 0n)
						}
						Atomics.store(newMask, newIndex, history)
					}
				}
			}
		}
	}

	/**
	 * Handles mask updates when entities are swapped within a chunk to fill holes from removals.
	 * This is a critical hook for maintaining mask integrity during `destroyEntity` operations.
	 */
	handleEntitiesSwapped = (chunkId, swapCount, oldIndices, newIndices) => {
		if (swapCount === 0) return

		// By iterating through mask sets first, we reduce redundant lookups and improve cache coherency.
		for (let maskSetId = 0; maskSetId < this.maskSetIdCounter; maskSetId++) {
			const maskSet = this.maskSets[maskSetId]
			const mask = maskSet.masksByChunk[chunkId]
			if (!mask) continue

			if (maskSet.type === this.MASK_TYPE.STATE) {
				for (let i = 0; i < swapCount; i++) {
					const oldIndex = oldIndices[i]
					const newIndex = newIndices[i]

					const oldWordIndex = oldIndex >>> 5
					const oldBitInWord = 1 << (oldIndex & 31)
					const isSet = (Atomics.load(mask, oldWordIndex) & oldBitInWord) !== 0

					const newWordIndex = newIndex >>> 5
					const newBitInWord = 1 << (newIndex & 31)

					if (isSet) Atomics.or(mask, newWordIndex, newBitInWord)
					else Atomics.and(mask, newWordIndex, ~newBitInWord)
					// The old location at `oldIndex` is now inaccessible because the chunk size has
					// been reduced. However, if a new entity is added to the chunk, it can occupy
					// this slot. We must clear the bit to prevent the new entity from inheriting a stale state.
					Atomics.and(mask, oldWordIndex, ~oldBitInWord)
				}
			} else if (maskSet.type === this.MASK_TYPE.EVENT) {
				// NEW "Entity-Major" Bulk Copy
				for (let i = 0; i < swapCount; i++) {
					const oldIndex = oldIndices[i]
					const newIndex = newIndices[i]

					// Load the history from the old (swapped-from) location.
					const history = Atomics.load(mask, oldIndex)
					// Store it at the new location.
					Atomics.store(mask, newIndex, history)
					// Clear the old location.
					Atomics.store(mask, oldIndex, 0n)
				}
			}
		}
	}

	/**
	 * Retrieves a reusable batch object from a pool to avoid allocations in hot paths.
	 * @private
	 */
	_getBatchFromPool() {
		let batch = this._moveBatchPool[this._poolIndex]
		if (!batch) {
			batch = { oldIndices: [], newIndices: [] }
			this._moveBatchPool.push(batch)
		}
		batch.oldIndices.length = 0
		batch.newIndices.length = 0
		this._poolIndex++
		return batch
	}
}

export const entityMaskManager = new EntityMaskManager()
