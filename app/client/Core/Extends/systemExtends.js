const { payloadCompiler } = await import(`@managers/SystemManager/PayloadCompiler.js`)
const { entityCommandBuffer } = await import(`@managers/SystemManager/EntityCommandBuffer.js`)
const { queryManager } = await import(`@managers/QueryManager/QueryManager.js`)
const { entityManager } = await import(`@managers/EntityManager/EntityManager.js`)
const { entityMaskManager } = await import(`@managers/EntityMaskManager/EntityMaskManager.js`)
const { ecs } = await import(`@managers/EntityManager/ECS.js`)

const { entityStore, MAX_CHUNK_CAPACITY } = await import(`@managers/EntityManager/EntityManager.js`)

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

	// --- Dirty Tracking Component Pattern Helpers ---
	// Broad-phase: Marks the entire component type as dirty for a chunk. Call this ONCE per chunk, outside the entity loop.
	markComponentDirty: (chunkId, componentTypeId, tick) =>
		entityManager.markComponentDirty(chunkId, componentTypeId, tick),

	// Narrow-phase: Marks a specific entity as dirty. Call this inside an entity loop for `isTrackable` components.
	markEntityDirty: (chunkId, indexInChunk, componentTypeId, tick) =>
		entityMaskManager.maskDirty(chunkId, indexInChunk, componentTypeId, tick),
	markEntityDirtyById: (entityId, componentTypeId, tick) =>
		entityMaskManager.maskDirtyById(entityId, componentTypeId, tick),

	markEntitiesDirty: (chunkId, indexInChunk, componentTypeIds, tick) =>
		entityMaskManager.markEntitiesDirty(chunkId, indexInChunk, componentTypeIds, tick),
	markEntitiesDirtyById: (entityId, componentTypeIds, tick) =>
		entityMaskManager.markEntitiesDirtyById(entityId, componentTypeIds, tick),

	// Querying for dirty entities (narrow-phase).
	getDirty: (chunkId, componentTypeId, lastTick, currentTick, outBuffer) =>
		entityMaskManager.getDirty(chunkId, componentTypeId, lastTick, currentTick, outBuffer),

	// --- Command Buffer: Bulk & Other ---
	destroyByQuery: (query, layer) => entityCommandBuffer.destroyByQuery(query, layer),
	destroyEntitiesInChunk: (chunkId, layer) => entityCommandBuffer.destroyEntitiesInChunk(chunkId, layer),
	instantiate: (payload, count = 1, layer) => entityCommandBuffer.instantiate(payload, count, layer),

	// Query-related helpers
	getComponentData: (chunkId, componentTypeId) => entityStore.chunkComponentData[chunkId][componentTypeId],
	getChunkSize: chunkId => entityStore.chunkSizes[chunkId],
	getEntities: chunkId => entityStore.chunkComponentData[chunkId].entities,
	getComponentTypeIDsForArchetype: archetypeId => entityManager.getComponentTypeIDsForArchetype(archetypeId),

	//query
	getQuery: options => queryManager.getQuery(options),

	// entity manager
	getEntityLocation: entityId => entityManager.getEntityLocation(entityId), // allocating.

	// This is a convenience for tests and HMR. It triggers the full compile->execute->clear sequence.
	// If no tick is provided, it defaults to `currentTick + 1` to align with the engine's reactivity model.
	// This now delegates to the central ECS API.
	flush: timestampTick => ecs.executeCommandBuffer(timestampTick),
}
