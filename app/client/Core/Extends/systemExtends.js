const { payloadCompiler } = await import(`@managers/SystemManager/PayloadCompiler.js`)
const { entityCommandBuffer } = await import(`@managers/SystemManager/EntityCommandBuffer.js`)
const { queryManager } = await import(`@managers/QueryManager/QueryManager.js`)
const { entityManager } = await import(`@managers/EntityManager/EntityManager.js`)
const { entityMaskManager } = await import(`@managers/EntityMaskManager/EntityMaskManager.js`)
const { ecs } = await import(`@managers/EntityManager/ECS.js`)
import { executionContext, CTX_CURRENT_VERSION_OFFSET, CTX_LAST_VERSION_OFFSET } from '@core/ExecutionContext.js'

const { entityStore, MAX_CHUNK_CAPACITY } = await import(`@managers/EntityManager/EntityManager.js`)

// Get a direct view into the execution context's shared buffer.
// This avoids a function call on every dirty mark, which can be a hot path.
const contextU32View = new Uint32Array(executionContext.getBuffer())

/**
 * A central configuration file for extending system instances.
 * Properties defined here will be directly assigned to every system instance
 * upon creation by the SystemManager.
 *
 * @devnote These properties are assigned *after* the system's constructor is called
 * but *before* its `init()` method is called. Therefore, they are available
 * in `init()` and subsequent methods, but **not** in the `constructor`.
 */
export const extensions = {
	// compiler
	compile: (source, options) => payloadCompiler.compile(source, options),

	// --- Command Buffer: Fast Path (for existing entities) ---
	addComponent: (entityId, payload, layer) => entityCommandBuffer.addComponent(entityId, payload, layer),
	addComponents: (entityId, payload, layer) => entityCommandBuffer.addComponents(entityId, payload, layer),
	addComponentSilent: (entityId, payload, layer) => entityCommandBuffer.addComponentSilent(entityId, payload, layer),
	addComponentsSilent: (entityId, payload, layer) => entityCommandBuffer.addComponentsSilent(entityId, payload, layer),
	addComponentsToEntities: (entityIds, payload, layer) =>
		entityCommandBuffer.addComponentsToEntities(entityIds, payload, layer),
	// `setComponent` is now an alias for `setComponents` for single-component data setting.
	setComponent: (entityId, payload, layer) => entityCommandBuffer.setComponents(entityId, payload, layer), 
	setComponentSilent: (entityId, payload, layer) => entityCommandBuffer.setComponentsSilent(entityId, payload, layer), 
	setComponents: (entityId, payload, layer) => entityCommandBuffer.setComponents(entityId, payload, layer),

	setEntities: (entityIds, payload, layer) => entityCommandBuffer.setEntities(entityIds, payload, layer),

	removeComponent: (entityId, componentTypeId, layer) =>
		entityCommandBuffer.removeComponent(entityId, componentTypeId, layer),
	removeComponents: (entityId, componentTypeIds, layer) =>
		entityCommandBuffer.removeComponents(entityId, componentTypeIds, layer),
	removeComponentsFromEntities: (entityIds, componentTypeIds, layer) =>
		entityCommandBuffer.removeComponentsFromEntities(entityIds, componentTypeIds, layer),
	
	destroyEntity: (entityId, layer) => entityCommandBuffer.destroyEntity(entityId, layer),

	// --- Enableable Component Pattern Helpers ---
	enableComponent: (chunkId, indexInChunk, componentTypeId) =>
		entityMaskManager.enableComponent(chunkId, indexInChunk, componentTypeId),
	disableComponent: (chunkId, indexInChunk, componentTypeId) =>
		entityMaskManager.disableComponent(chunkId, indexInChunk, componentTypeId),
	enableComponentById: (entityId, componentTypeId) => entityMaskManager.enableComponentById(entityId, componentTypeId),
	disableComponentById: (entityId, componentTypeId) =>
		entityMaskManager.disableComponentById(entityId, componentTypeId),
	createScratchBuffer: () => new Uint32Array(MAX_CHUNK_CAPACITY),
	isComponentEnabled: (chunkId, indexInChunk, componentTypeId) =>
		entityMaskManager.isComponentEnabled(chunkId, indexInChunk, componentTypeId),
	getEnabled: (chunkId, componentTypeId, outBuffer) =>
		entityMaskManager.getEnabled(chunkId, componentTypeId, outBuffer),
	getIndicesFromMask: (maskId, chunkId, outBuffer) => entityMaskManager.getIndicesFromMask(maskId, chunkId, outBuffer),
	getMaskId: name =>
		entityMaskManager.getMaskIdByName(name),
	setBit: (maskId, chunkId, indexInChunk) =>
		entityMaskManager.setBit(maskId, chunkId, indexInChunk),
	clearBit: (maskId, chunkId, indexInChunk) =>
		entityMaskManager.clearBit(maskId, chunkId, indexInChunk),
	isBitSet: (maskId, chunkId, indexInChunk) =>
		entityMaskManager.isBitSet(maskId, chunkId, indexInChunk),

	// --- Dirty Tracking Component Pattern Helpers ---
	// Broad-phase: Marks the entire component type as dirty for a chunk. Call this ONCE per chunk, outside the entity loop.
	markComponentDirty: (chunkId, componentTypeId) => {
		const version = contextU32View[CTX_CURRENT_VERSION_OFFSET]
		entityManager.markComponentDirty(chunkId, componentTypeId, version)
	},

	// Narrow-phase: Marks a specific entity as dirty. Call this inside an entity loop for `isTrackable` components.
	markEntityDirty: (chunkId, indexInChunk, componentTypeId) => {
		const version = contextU32View[CTX_CURRENT_VERSION_OFFSET]
		entityManager.markEntityDirty(chunkId, indexInChunk, componentTypeId, version)
	},
	markEntityDirtyById: (entityId, componentTypeId) => {
		const version = contextU32View[CTX_CURRENT_VERSION_OFFSET]
		entityManager.markEntityDirtyById(entityId, componentTypeId, version)
	},

	markEntitiesDirty: (chunkId, indexInChunk, componentTypeIds) => {
		const version = contextU32View[CTX_CURRENT_VERSION_OFFSET]
		entityManager.markEntitiesDirty(chunkId, indexInChunk, componentTypeIds, version)
	},
	markEntitiesDirtyById: (entityId, componentTypeIds) => {
		const version = contextU32View[CTX_CURRENT_VERSION_OFFSET]
		entityManager.markEntitiesDirtyById(entityId, componentTypeIds, version)
	},

	// Querying for dirty entities (narrow-phase).
	getDirty: (chunkId, componentTypeId, outBuffer) => {
		// This helper automatically reads the correct version range from the global execution context,
		// simplifying system code.
		const lastVersion = contextU32View[CTX_LAST_VERSION_OFFSET]
		const currentVersion = contextU32View[CTX_CURRENT_VERSION_OFFSET]
		return entityManager.getDirty(chunkId, componentTypeId, lastVersion, currentVersion, outBuffer)
	},

	// --- Command Buffer: Bulk & Other ---
	destroyByQuery: (query, layer) => entityCommandBuffer.destroyByQuery(query, layer),
	destroyEntitiesInChunk: (chunkId, layer) => entityCommandBuffer.destroyEntitiesInChunk(chunkId, layer),
	instantiate: (payload, count = 1, layer) => entityCommandBuffer.instantiate(payload, count, layer),
	instantiateSilent: (payload, count = 1, layer) => entityCommandBuffer.instantiateSilent(payload, count, layer),

	// Query-related helpers
	getComponentData: (chunkId, componentTypeId) => entityStore.chunkComponentData[chunkId][componentTypeId],
	getChunkSize: chunkId => entityStore.chunkSizes[chunkId],
	getEntities: chunkId => entityStore.chunkComponentData[chunkId].entities,
	getComponentTypeIDsForArchetype: archetypeId => entityManager.getComponentTypeIDsForArchetypeAlloc(archetypeId),

	//query
	getQuery: options => queryManager.getQuery(options),

	// entity manager
	getEntityLocation: entityId => entityManager.getEntityLocation(entityId), // allocating.

	// This is a convenience for tests and HMR. It triggers the full compile->execute->clear sequence.
	// If no tick is provided, it defaults to `currentTick + 1` to align with the engine's reactivity model.
	// This now delegates to the central ECS API.
	flush: timestampTick => ecs.executeCommandBuffer(timestampTick),
}
