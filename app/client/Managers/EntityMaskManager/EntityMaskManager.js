import { entityStore, MAX_CHUNKS, MASK_PARTS } from '../EntityManager/EntityManager.js'
import { DIRTY_HISTORY_LENGTH, componentInfo } from '../ComponentManager/ComponentSchema.js'

const MASK_TYPE = {
	STATE: 0,
	EVENT: 1,
}

/* Turns O(N) problems into O(K) problems (where K is the count of relevant entities). */

//! only useful when need to filter out small subset,
//! bypassing archetype churn,
//! where ~<10% entities needs to be processed.

//! Performance at scale needs to be revisited
//! custom bitmask-oriented implementation of a LSM Tree?

//! Make part of query as enabled:[componentID]?

export class EntityMaskManager {
	constructor() {
		this.entityManager = null

		// --- Internal State ---
		this.maskSets = [] // Array of { name, type, allocationQuery, historyLength, masksByChunk }
		this.maskSetIdCounter = 0
		this.nameToId = new Map()
		this.chunksWithEventMasks = new Set()
		this.componentToEnableMaskId = new Map()
		this.componentToModifiedMaskId = new Map()

		// --- Pre-allocated structures for performance ---
		this._movesByChunkPair = new Map()
		this._moveBatchPool = []
		this._poolIndex = 0
	}

	init(engine) {
		this.entityManager = engine.entityManager

		this.registerAllSchemaMasks()
	}

	registerAllSchemaMasks() {
		// --- Declarative Mask Registration ---
		// At startup, discover all components that declared they need masks
		// and register them upfront. This avoids race conditions from on-demand
		// registration within systems.
		const allComponentInfo = componentInfo
		for (const info of allComponentInfo) {
			if (info) {
				if (info.isEnableable) {
					this.registerEnableableMask(info.typeID)
				}
				if (info.isTrackable) {
					this.registerModifiedMask(info.typeID)
				}
			}
		}
	}

	// =================================================================
	// PUBLIC API - HIGH LEVEL HELPERS
	// =================================================================

	getEnabledMask(componentTypeId) {
		// This is now a simple getter. The mask must have been registered at startup.
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

	registerEnableableMask(componentTypeId) {
		if (this.componentToEnableMaskId.has(componentTypeId)) {
			return this.componentToEnableMaskId.get(componentTypeId)
		}

		// Create a direct allocation rule definition.
		const allocationRuleDef = { with: [componentTypeId] }
		const maskId = this.createStateMask(`_enableable:${componentTypeId}`, allocationRuleDef)
		this.componentToEnableMaskId.set(componentTypeId, maskId)
		return maskId
	}

	getEnabled(chunkId, componentTypeId, outBuffer) {
		const maskId = this.componentToEnableMaskId.get(componentTypeId)
		// If maskId is undefined here, it means the component was not declared as
		// `isEnableable`. The subsequent call to getStateIndices will throw a native
		// TypeError, which is the desired behavior.
		return this.getStateIndices(maskId, chunkId, outBuffer)
	}

	getDirtyMask(componentTypeId) {
		// This is now a simple getter. The mask must have been registered at startup.
		// If this returns undefined, it means the component was not declared with
		// `meta: { isTrackable: true }` in its schema. The calling function will throw
		// a native error, which is the desired behavior.
		return this.componentToModifiedMaskId.get(componentTypeId)
	}

	registerModifiedMask(componentTypeId) {
		if (this.componentToModifiedMaskId.has(componentTypeId)) {
			return this.componentToModifiedMaskId.get(componentTypeId)
		}

		// Create a direct allocation rule definition.
		const allocationRuleDef = { with: [componentTypeId] }
		const maskId = this.createEventMask(`_modified:${componentTypeId}`, allocationRuleDef)
		this.componentToModifiedMaskId.set(componentTypeId, maskId)
		return maskId
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
		const location = this.entityManager.getEntityLocation(entityId)

		this.markEntitiesDirty(location.chunkId, location.indexInChunk, componentTypeIds, tick)
	}

	getDirty(chunkId, componentTypeId, lastTick, currentTick, outBuffer) {
		const maskId = this.getDirtyMask(componentTypeId)
		// If maskId is undefined, the component was not declared as `isTrackable`.
		// The subsequent call to getEventIndicesSince will throw a native TypeError.
		return this.getEventIndicesSince(maskId, chunkId, lastTick, currentTick, outBuffer)
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
			type: MASK_TYPE.STATE,
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
			type: MASK_TYPE.EVENT,
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
		if (maskSet.type !== MASK_TYPE.STATE) {
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
		if (maskSet.type !== MASK_TYPE.STATE) {
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
		if (maskSet.type !== MASK_TYPE.EVENT) {
			throw new Error(`[EntityMaskManager] fireEvent called on a non-event mask set "${maskSet.name}".`)
		}

		const eventMasks = maskSet.masksByChunk[chunkId]
		// If `eventMasks` is undefined, it means the mask was not allocated for this chunk.
		// This can happen if we are operating on a stale chunkId that has been destroyed
		// and recycled for an archetype that doesn't match the mask's allocation rule. This is
		// a developer error. The following line will intentionally throw a TypeError, which is
		// the desired behavior to catch such errors. A silent failure would hide bugs.

		const wordsPerFrame = Math.ceil(entityStore.chunkCapacities[chunkId] / 32)
		const frameIndex = ((tick % maskSet.historyLength) + maskSet.historyLength) % maskSet.historyLength
		const wordIndexInFrame = indexInChunk >>> 5
		const bitInWord = 1 << (indexInChunk & 31)
		const finalWordIndex = frameIndex * wordsPerFrame + wordIndexInFrame

		Atomics.or(eventMasks, finalWordIndex, bitInWord)
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
		if (maskSet.type !== MASK_TYPE.STATE) {
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

	getStateIndices(maskSetId, chunkId, outBuffer) {
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

	getEventIndicesSince(maskSetId, chunkId, lastTick, currentTick, outBuffer) {
		const maskSet = this.maskSets[maskSetId]
		// If `maskSet` is undefined, it's likely because `maskSetId` was undefined.
		// This can happen if getDirty() was called for a component that was not
		// declared as `isTrackable` in its schema. The following line will then throw
		// a native TypeError, which is the desired behavior to signal a developer error.
		const eventMasks = maskSet.masksByChunk[chunkId]
		// If `eventMasks` is undefined, it means this mask was not allocated for this chunk.
		// This is a developer error. The following line will intentionally throw a TypeError.
		// A silent `return 0` was removed because it can hide bugs.
		
		const size = entityStore.chunkSizes[chunkId]
		const capacity = entityStore.chunkCapacities[chunkId]
		const numWords = Math.ceil(capacity / 32)
		const historyLength = maskSet.historyLength

		const tickDelta = currentTick - lastTick
		let startTick
		if (tickDelta >= historyLength) {
			startTick = currentTick - historyLength + 1
		} else {
			startTick = lastTick + 1
		}
		const endTick = currentTick

		if (startTick > endTick) return 0

		let count = 0
		for (let wordIndex = 0; wordIndex < numWords; wordIndex++) {
			let effectiveMask = 0

			for (let tick = startTick; tick <= endTick; tick++) {
				const frameIndex = ((tick % historyLength) + historyLength) % historyLength
				const finalWordIndex = frameIndex * numWords + wordIndex
				effectiveMask |= Atomics.load(eventMasks, finalWordIndex)
			}

			if (effectiveMask === 0) continue

			const offset = wordIndex << 5
			while (effectiveMask !== 0) {
				const t = effectiveMask & -effectiveMask
				const indexInWord = 31 - Math.clz32(t)
				const entityIndex = offset | indexInWord

				if (entityIndex >= size) break

				outBuffer[count++] = entityIndex
				effectiveMask ^= t
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
	}

	performMaintenance(chunkId, currentTick) {
		for (let maskSetId = 0; maskSetId < this.maskSetIdCounter; maskSetId++) {
			const maskSet = this.maskSets[maskSetId]
			if (maskSet.type !== MASK_TYPE.EVENT) continue

			const eventMasks = maskSet.masksByChunk[chunkId]
			if (!eventMasks) continue

			const maskHistoryLength = maskSet.historyLength
			const capacity = entityStore.chunkCapacities[chunkId]
			const wordsPerFrame = Math.ceil(capacity / 32)

			// --- Saturated History Logic ---
			// This ensures that events from very old ticks are not lost, but are "saturated"
			// into the next frame, preserving the fact that a change occurred.
			const oldestTickToOverwrite = currentTick + 1 - maskHistoryLength
			const saturatingTick = oldestTickToOverwrite + 1

			const oldestFrameIndex = ((oldestTickToOverwrite % maskHistoryLength) + maskHistoryLength) % maskHistoryLength
			const saturatingFrameIndex = ((saturatingTick % maskHistoryLength) + maskHistoryLength) % maskHistoryLength
			const oldestSliceStart = oldestFrameIndex * wordsPerFrame
			const saturatingSliceStart = saturatingFrameIndex * wordsPerFrame

			for (let i = 0; i < wordsPerFrame; i++) {
				const oldValue = Atomics.load(eventMasks, oldestSliceStart + i)
				if (oldValue !== 0) Atomics.or(eventMasks, saturatingSliceStart + i, oldValue)
			}

			// The slot for the *next* tick needs to be cleared before it's used.
			const tickToClear = currentTick + 1
			const clearFrameIndex = ((tickToClear % maskHistoryLength) + maskHistoryLength) % maskHistoryLength
			const clearSliceStart = clearFrameIndex * wordsPerFrame

			// Clear: Zero out the slot for the upcoming frame
			eventMasks.fill(0, clearSliceStart, clearSliceStart + wordsPerFrame)
		}
	}

	getChunksWithEventMasks() {
		return this.chunksWithEventMasks
	}

	handleChunkCreated = (chunkId, archetypeId) => {
		for (let maskSetId = 0; maskSetId < this.maskSetIdCounter; maskSetId++) {
			const maskSet = this.maskSets[maskSetId]
			if (this._archetypeMatches(archetypeId, maskSet.allocationRule)) {
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

	_archetypeMatches(archetypeId, rule) {
		const { with: withMask, without: withoutMask } = rule
		const archetypeMaskOffset = archetypeId * MASK_PARTS

		// Check required components
		if (withMask) {
			for (let i = 0; i < MASK_PARTS; i++) {
				if ((entityStore.archetypeMasks[archetypeMaskOffset + i] & withMask[i]) !== withMask[i]) {
					return false
				}
			}
		}

		// Check excluded components
		if (withoutMask) {
			for (let i = 0; i < MASK_PARTS; i++) {
				if ((entityStore.archetypeMasks[archetypeMaskOffset + i] & withoutMask[i]) !== 0n) {
					return false
				}
			}
		}
		return true
	}

	_allocateMaskForChunk(maskSet, chunkId) {
		const capacity = entityStore.chunkCapacities[chunkId]

		if (maskSet.type === MASK_TYPE.STATE) {
			const words = Math.ceil(capacity / 32)
			const buffer = new SharedArrayBuffer(words * 4)
			maskSet.masksByChunk[chunkId] = new Uint32Array(buffer)
		} else if (maskSet.type === MASK_TYPE.EVENT) {
			const wordsPerFrame = Math.ceil(capacity / 32)
			const totalWords = wordsPerFrame * maskSet.historyLength
			const buffer = new SharedArrayBuffer(totalWords * 4)
			maskSet.masksByChunk[chunkId] = new Uint32Array(buffer)
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

				if (maskSet.type === MASK_TYPE.STATE) {
					for (let i = 0; i < oldIndices.length; i++) {
						const oldIndex = oldIndices[i]
						const newIndex = newIndices[i]

						let isSet = false
						// Only read from oldMask if it exists.
						if (oldMask) {
							const oldWordIndex = oldIndex >>> 5
							const oldBitInWord = 1 << (oldIndex & 31)
							isSet = (Atomics.load(oldMask, oldWordIndex) & oldBitInWord) !== 0
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
				} else if (maskSet.type === MASK_TYPE.EVENT) {
					const newCapacity = entityStore.chunkCapacities[newChunkId]
					const newWordsPerFrame = Math.ceil(newCapacity / 32)

					for (let i = 0; i < oldIndices.length; i++) {
						const oldIndex = oldIndices[i]
						const newIndex = newIndices[i]

						const newWordIndexInFrame = newIndex >>> 5
						const newBitInWord = 1 << (newIndex & 31)

						if (oldMask) {
							const oldCapacity = entityStore.chunkCapacities[oldChunkId]
							const oldWordsPerFrame = Math.ceil(oldCapacity / 32)
							const oldWordIndexInFrame = oldIndex >>> 5
							const oldBitInWord = 1 << (oldIndex & 31)

							for (let frame = 0; frame < maskSet.historyLength; frame++) {
								const oldFrameOffset = frame * oldWordsPerFrame
								const oldFinalWordIndex = oldFrameOffset + oldWordIndexInFrame
								const isSetInFrame = (Atomics.load(oldMask, oldFinalWordIndex) & oldBitInWord) !== 0

								const newFrameOffset = frame * newWordsPerFrame
								const newFinalWordIndex = newFrameOffset + newWordIndexInFrame
								if (isSetInFrame) {
									Atomics.or(newMask, newFinalWordIndex, newBitInWord)
								} else {
									Atomics.and(newMask, newFinalWordIndex, ~newBitInWord)
								}
							}
						} else {
							// If oldMask doesn't exist, the event state is implicitly 0.
							// We need to clear the bits at the new location for all history frames.
							for (let frame = 0; frame < maskSet.historyLength; frame++) {
								const newFrameOffset = frame * newWordsPerFrame
								const newFinalWordIndex = newFrameOffset + newWordIndexInFrame
								Atomics.and(newMask, newFinalWordIndex, ~newBitInWord)
							}
						}
					}
				}
			}
		}
	}

	/**
	 * Handles mask updates when entities are swapped within a chunk to fill holes from removals.
	 * This is a critical hook for maintaining mask integrity during `destroyEntity` operations.
	 */
	handleEntitiesSwapped = ({ chunkId, swappedMappings }) => {
		if (swappedMappings.size === 0) return

		// By iterating through mask sets first, we reduce redundant lookups and improve cache coherency.
		for (let maskSetId = 0; maskSetId < this.maskSetIdCounter; maskSetId++) {
			const maskSet = this.maskSets[maskSetId]
			const mask = maskSet.masksByChunk[chunkId]
			if (!mask) continue

			if (maskSet.type === MASK_TYPE.STATE) {
				for (const [, { oldIndex, newIndex }] of swappedMappings.entries()) {
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
			} else if (maskSet.type === MASK_TYPE.EVENT) {
				const capacity = entityStore.chunkCapacities[chunkId]
				const wordsPerFrame = Math.ceil(capacity / 32)

				for (const [, { oldIndex, newIndex }] of swappedMappings.entries()) {
					const oldWordIndexInFrame = oldIndex >>> 5
					const oldBitInWord = 1 << (oldIndex & 31)
					const newWordIndexInFrame = newIndex >>> 5
					const newBitInWord = 1 << (newIndex & 31)

					for (let frame = 0; frame < maskSet.historyLength; frame++) {
						const frameOffset = frame * wordsPerFrame
						const oldFinalWordIndex = frameOffset + oldWordIndexInFrame
						const isSetInFrame = (Atomics.load(mask, oldFinalWordIndex) & oldBitInWord) !== 0

						const newFinalWordIndex = frameOffset + newWordIndexInFrame
						if (isSetInFrame) Atomics.or(mask, newFinalWordIndex, newBitInWord)
						else Atomics.and(mask, newFinalWordIndex, ~newBitInWord)
						// As with state masks, we must clear the old location to prevent stale data inheritance.
						Atomics.and(mask, oldFinalWordIndex, ~oldBitInWord)
					}
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
