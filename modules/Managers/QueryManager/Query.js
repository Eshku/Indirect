const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { Chunk, CHUNK_SIZE } = await import(`${PATH_MANAGERS}/ArchetypeManager/Chunk.js`)

/**
 * --- ARCHITECTURAL NOTE on Query Design (Unity IJobChunk-Style) ---
 *
 * The design of our query system is inspired by the robust and explicit model used in
 * Unity's Data-Oriented Technology Stack (DOTS). This approach prioritizes API consistency,
 * explicitness, and performance by iterating over chunks of data rather than individual entities.
 *
 * 1.  **A Single, Consistent API**: The `query.iter()` method is the single entry point
 *     for all iteration. It yields each **Chunk** of entities that match the query's
 *     structural definition. A Chunk is a small, cache-friendly block of entities.
 *
 * 2.  **Unified Inner Loop**: Systems iterate over chunks and then over the entities
 *     within them. This allows for a perfectly consistent inner loop, regardless of
 *     whether the query is reactive or not.
 *
 *     The canonical loop structure for a **non-reactive** query:
 *     ```javascript
 *     for (const chunk of this.query.iter()) {
 *         const positionAccessor = chunk.archetype.getComponentAccessor(this.positionTypeID)
 *         for (const entityIndex of chunk) { // `entityIndex` is the index in the archetype
 *             const position = positionAccessor.get(entityIndex)
 *             // ... your logic here ...
 *         }
 *     }
 *     ```
 *
 *     The canonical loop structure for a **reactive** query, which processes only
 *     entities whose monitored components have changed:
 *     ```javascript
 *     for (const chunk of this.query.iter()) {
 *         const positionAccessor = chunk.archetype.getComponentAccessor(this.positionTypeID)
 *         for (const entityIndex of chunk) {
 *             if (this.query.hasChanged(chunk.archetype, entityIndex)) { // Fine-grained check
 *                 const position = positionAccessor.get(entityIndex);
 *                 // ... your logic here for changed entities ...
 *             }
 *         }
 *     }
 *     ```
 *
 * 3.  **Performance**: This design is highly performant.
 *     - **Zero Allocations in Loops**: The `query.iter()` method assigns the correct
 *       underlying iterator at construction time, avoiding branching in the hot path. The
 *       `hasChanged()` check is also highly optimized and allocation-free.
 *     - **Broad-Phase Culling**: Reactive queries perform a highly effective broad-phase
 *       cull, skipping entire archetypes where no relevant components have been modified.
 *     - **Data Locality**: Iterating chunk-by-chunk improves data locality, which is
 *       fundamental for CPU cache performance.
 *
 * 4.  **Safety and Predictability**: Structural changes (adding/removing components) are
 *     deferred via a `CommandBuffer`. This prevents iterator invalidation and makes system
 *     logic safer and more predictable. The `CommandBuffer` operates on stable `entityId`s,
 *     which can be retrieved via `chunk.archetype.entities[entityIndex]`.
 *
 * 5.  **Performance Over Protection**: In line with the goals of a low-level engine, query methods
 *     in the hot path do NOT perform runtime checks to validate their execution context. It is the
 *     developer's responsibility to use these methods correctly (i.e., within a system managed
 *     by `SystemManager`). Misuse will lead to undefined and incorrect behavior, not runtime errors.
 *     This trade-off maximizes performance.
 */

export class Query {
	/**
	 * A static helper to create a bitmask from component classes.
	 * It's a static method for performance, preventing a new function from being created
	 * for every Query instance.
	 * @param {import('../ComponentManager/ComponentManager').ComponentManager} componentManager - The manager to resolve type IDs.
	 * @param {Function[]} componentClasses - The component classes to convert.
	 * @param {string} categoryName - A name for the component list, used in error messages.
	 * @returns {bigint} A bitmask representing the component classes.
	 * @private
	 */
	static _createSimpleMask(componentManager, componentClasses, categoryName) {
		let mask = 0n
		for (const CompClass of componentClasses) {
			const bitFlag = componentManager.getComponentBitFlag(CompClass)
			if (bitFlag === undefined) {
				throw new Error(`Query: ${categoryName} component class ${CompClass.name} is not registered.`)
			}
			mask |= bitFlag
		}
		return mask
	}

	/** @private */
	static _createComponentTypeIDSet(componentManager, componentClasses, categoryName) {
		const typeIDs = new Set()
		for (const CompClass of componentClasses) {
			const typeID = componentManager.getComponentTypeID(CompClass)
			if (typeID === undefined) {
				throw new Error(`Query: ${categoryName} component class ${CompClass.name} is not registered.`)
			}
			typeIDs.add(typeID)
		}
		return Object.freeze(typeIDs)
	}

	/**
	 * Entity must satisfy ALL requiredComponentClasses,
	 * NONE of the excludedComponentClasses,
	 * AND at least one of the anyOfComponentClasses (if any are specified).	 *
	 * AND pass all filter predicates (if any are specified).
	 *
	 * @param {Function[]} withComponents
	 * @param {Function[]} withoutComponents - An array of component classes that an entity must NOT have.
	 * @param {Function[]} anyComponents
	 * @param {Function[]} reactComponents
	 */
	constructor(withComponents, withoutComponents = [], anyComponents = [], reactComponents = []) {
		// NOTE: This constructor assumes it is being called by QueryManager, which is responsible
		// for validating the arguments (e.g., ensuring requiredComponentClasses is not empty
		// and that all arguments are arrays). This keeps the constructor clean and focused.
		this.componentManager = theManager.getManager('ComponentManager')

		this.archetypeManager = theManager.getManager('ArchetypeManager')

		/**
		 * The last tick of the system group currently being executed.
		 * This is set directly by the SystemManager before a system's update loop for performance.
		 * It should only be written to by the SystemManager.
		 * @type {number | null}
		 */
		this.iterationLastTick = null

		/**
		 * A reusable chunk object to avoid allocations during iteration.
		 * @type {Chunk}
		 * @private
		 */
		this._reusableChunk = new Chunk(null, 0, 0)

		const withMask = Query._createSimpleMask(this.componentManager, withComponents, 'With')
		const reactMask = Query._createSimpleMask(this.componentManager, reactComponents, 'React')

		this._requiredMask = withMask | reactMask
		this._excludedMask = Query._createSimpleMask(this.componentManager, withoutComponents, 'Without')
		this._anyOfMask = Query._createSimpleMask(this.componentManager, anyComponents, 'AnyOf')
		this._reactiveMask = reactMask

		/**
		 * The bitmask for components to check for changes in a reactive query.
		 * @type {bigint}
		 * @private
		 */

		/**
		 * A read-only flag indicating if this query monitors for component changes.
		 * @type {boolean}
		 */
		this.isReactiveQuery = this._reactiveMask > 0n

		/**
		 * A list of archetypes that currently match this query.
		 * This list is populated and updated by the QueryManager or when results are requested.
		 * @type {number[]} An array of archetype internal IDs.
		 */
		this.matchingArchetypeIds = []

		// For reactive queries, we need a map to cache relevant type IDs per archetype.
		// This is a key optimization, moving this calculation out of the hot `forEach` loop.
		if (this.isReactiveQuery) {
			// This still stores numeric typeIDs for easy iteration in hasChanged
			this._reactiveTypeIDsByArchetype = [] // Use an array indexed by archetype.id for max speed
			this._reactiveComponentTypeIDs = Query._createComponentTypeIDSet(this.componentManager, reactComponents, 'React')
		}

		// Assign the correct iterator function once during construction
		// to avoid a conditional check in the hot path of every system's loop.

		if (this.isReactiveQuery) {
			this.iter = this._iterChangedArchetypes
		} else {
			this.iter = this._iterAllArchetypes
		}
	}

	/**
	 * The public-facing iterator for all queries. It is assigned to the correct
	 * underlying archetype iterator (`_iterAllArchetypes` or `_iterChangedArchetypes`)
	 * during the query's construction, based on whether the query is reactive.
	 *
	 * This avoids a conditional check in the hot path of every system's loop.
	 * @returns {Generator<Chunk, void, void>}
	 */
	iter() {
		// This method is dynamically replaced in the constructor.
		// This body is a fallback and should not be executed.
		throw new Error('Query iterator not initialized. This is an internal error.')
	}

	/**
	 * The iterator for non-reactive queries. Yields every matching archetype, sliced into Chunks.
	 * @private
	 */
	*_iterAllArchetypes() {
		for (const archetypeId of this.matchingArchetypeIds) {
			const archetype = this.archetypeManager.getData(archetypeId)
			if (archetype.entityCount > 0) {
				// Slice the archetype into fixed-size chunks.
				for (let i = 0; i < archetype.entityCount; i += CHUNK_SIZE) {
					const count = Math.min(CHUNK_SIZE, archetype.entityCount - i)
					this._reusableChunk._init(archetype, i, count)
					yield this._reusableChunk
				}
			}
		}
	}

	/**
	 * The iterator for reactive queries. Yields chunks from every matching archetype that has changed entities.
	 * @private
	 */
	*_iterChangedArchetypes() {
		for (const archetypeId of this.matchingArchetypeIds) {
			const archetype = this.archetypeManager.getData(archetypeId)
			// Skip this entire archetype if no component in it has been
			// dirtied since the last time this system's group ran. This is a highly
			// effective broad-phase cull.
			if (this.archetypeManager.archetypeMaxDirtyTicks[archetypeId] <= this.iterationLastTick) {
				continue
			}

			// The archetype *might* contain changed entities. Yield its chunks.
			// The inner loop in the system will use `query.hasChanged()` to do the
			// fine-grained check per entity.
			if (archetype.entityCount > 0) {
				for (let i = 0; i < archetype.entityCount; i += CHUNK_SIZE) {
					const count = Math.min(CHUNK_SIZE, archetype.entityCount - i)
					this._reusableChunk._init(archetype, i, count) // Chunk needs the full data object
					yield this._reusableChunk
				}
			}
		}
	}

	/**
	 * For a reactive query, checks if an entity's monitored components have changed
	 * since the system last ran. This is the explicit, fine-grained check analogous
	 * to Unity's `DidChange()`.	 *
	 * @warning This is a low-level method that MUST be called on a reactive query within a `SystemManager`-controlled loop.
	 * The `iterationLastTick` property must be set before calling this method, otherwise
	 * behavior is undefined and will likely be incorrect.
	 *
	 * @param {object} archetype The archetype data object being iterated.
	 * @param {number} entityIndex The index of the entity within the archetype.
	 * @returns {boolean} `true` if the entity is a match, `false` otherwise.
	 */
	hasChanged(archetype, entityIndex) {
		// For performance, this method has no runtime checks. It is the developer's
		// responsibility to ensure it is called only on a reactive query and within a system's
		// update loop where `iterationLastTick` has been set by the SystemManager.
		const tickToProcess = this.iterationLastTick

		// This is the fine-grained check. We iterate over only the component types
		// this reactive query cares about and check their individual dirty ticks.
		// This is extremely fast as it's just a few direct lookups in TypedArrays.
		// check the specific components this query cares about.		const relevantTypeIDs = this._reactiveTypeIDsByArchetype[archetype.id]
		const relevantTypeIDs = this._reactiveTypeIDsByArchetype[archetype.id]
		if (!relevantTypeIDs) return false // Should not happen for matching archetypes

		for (const typeID of relevantTypeIDs) {
			const dirtyTick = this.archetypeManager.getDirtyTick(archetype.id, entityIndex, typeID)
			if (dirtyTick !== undefined && dirtyTick > tickToProcess) {
				return true
			}
		}

		return false
	}

	/**
	 * Checks if a given archetype matches this query's requirements.
	 * @param {number} archetypeId The internal ID of the archetype to check.
	 * @returns {boolean}
	 * @private
	 */
	archetypeMatches(archetypeId) {
		const archetypeMask = this.archetypeManager.getData(archetypeId).mask

		// 1. Check if all required components are present.
		// (archetypeMask & requiredMask) must be equal to requiredMask.
		if ((archetypeMask & this._requiredMask) !== this._requiredMask) {
			return false
		}

		// 2. Check if any excluded components are present.
		// (archetypeMask & excludedMask) must be 0.
		if ((archetypeMask & this._excludedMask) !== 0n) {
			return false
		}

		// 3. Check if at least one of the "any of" components is present.
		// This is only necessary if the anyOfMask is not 0.
		if (this._anyOfMask !== 0n && (archetypeMask & this._anyOfMask) === 0n) {
			return false
		}

		return true
	}

	/**
	 * Checks if the given new archetype matches this query and adds it to the list if it does.
	 * Called by QueryManager.
	 * @param {number} newArchetypeId - The internal ID of the new archetype to check.
	 */
	checkAndAddArchetype(newArchetypeId) {
		if (this.archetypeMatches(newArchetypeId)) {
			// If this is a 'changed' query, pre-calculate and cache the relevant type IDs for this archetype.
			// This is a key optimization, moving this calculation out of the hot loop.
			if (this.isReactiveQuery) {
				const relevantTypeIDs = []
				for (const typeID of this._reactiveComponentTypeIDs) {
					if (this.archetypeManager.hasComponentType(newArchetypeId, typeID)) {
						relevantTypeIDs.push(typeID)
					}
				}
				this._reactiveTypeIDsByArchetype[newArchetypeId] = relevantTypeIDs
			}
			this.matchingArchetypeIds.push(newArchetypeId)
		}
	}

	/**
	 * Removes a deleted archetype from this query's list of matching archetypes.
	 * Called by QueryManager.
	 * @param {number} deletedArchetypeId - The internal ID of the archetype to remove.
	 */
	removeArchetype(deletedArchetypeId) {
		const index = this.matchingArchetypeIds.indexOf(deletedArchetypeId)
		if (index > -1) {
			this.matchingArchetypeIds.splice(index, 1)
			// If this is a reactive query, remove the archetype from the cache.
			if (this.isReactiveQuery) {
				this._reactiveTypeIDsByArchetype[deletedArchetypeId] = undefined
			}
		}
	}

	/**
	 * Sets new criteria for the query, completely replacing the old ones.
	 * This is a destructive operation that will cause the query to re-evaluate all existing archetypes.
	 * @param {object} criteria - The new criteria for the query.
	 * @param {Function[]} [criteria.with] - New array of 'with' component classes.
	 * @param {Function[]} [criteria.without] - New array of 'without' component classes.
	 * @param {Function[]} [criteria.any] - New array of 'any' component classes.
	 * @param {Function[]} [criteria.react] - New array of 'react' component classes.
	 */
	setCriteria({ with: withComps, without, any, react }) {
		const archetypeManager = theManager.getManager('ArchetypeManager')

		// Update masks. If a criterion is not provided, keep the old one.
		if (withComps || react) {
			const withMask = Query._createSimpleMask(this.componentManager, withComps || [], 'With')
			const reactMask = Query._createSimpleMask(this.componentManager, react || [], 'React')
			this._requiredMask = withMask | reactMask
		}

		if (without) this._excludedMask = Query._createSimpleMask(this.componentManager, without, 'Without')
		if (any) this._anyOfMask = Query._createSimpleMask(this.componentManager, any, 'AnyOf')

		if (react) {
			this._reactiveMask = Query._createSimpleMask(this.componentManager, react, 'React')
			this.isReactiveQuery = this._reactiveMask > 0n

			// Update reactive-specific properties
			if (this.isReactiveQuery) {
				this._reactiveComponentTypeIDs = Query._createComponentTypeIDSet(this.componentManager, react, 'React')
				this._reactiveTypeIDsByArchetype = [] // Clear the cache
			} else {
				this._reactiveComponentTypeIDs = undefined
				this._reactiveTypeIDsByArchetype = undefined
			}
		}

		// Re-assign the correct iterator function
		if (this.isReactiveQuery) {
			this.iter = this._iterChangedArchetypes
		} else {
			this.iter = this._iterAllArchetypes
		}

		// Clear current matching archetypes
		this.matchingArchetypeIds.length = 0

		// Re-evaluate all existing archetypes against the new criteria
		for (const archetypeId of archetypeManager.archetypeLookup.values()) {
			this.checkAndAddArchetype(archetypeId)
		}
	}

	/**
	 * Destroys the query, unregistering it from the QueryManager so it no longer
	 * receives updates. This should be called by the owning system when
	 * it is destroyed to prevent memory leaks.
	 * @throws {Error} If called on an immutable (shared) query.
	 */
	destroy() {
		const queryManager = theManager.getManager('QueryManager')
		queryManager.destroyQuery(this)
	}
}
