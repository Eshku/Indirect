const { payloadCompiler } = await import(`@managers/SystemManager/PayloadCompiler.js`)
const { commandBuffer } = await import(`@managers/SystemManager/CommandBuffer.js`)
const { queryManager } = await import(`@managers/QueryManager/QueryManager.js`)
const { entityManager } = await import(`@managers/EntityManager/EntityManager.js`)
const { entityMaskManager } = await import(`@managers/EntityMaskManager/EntityMaskManager.js`)

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
	compile: (source, dataOrOverrides) => payloadCompiler.compile(source, dataOrOverrides),
	compileDefaults: (source, overrides, ignores) => payloadCompiler.compileDefaults(source, overrides, ignores),
	compileBatch: componentsObject => payloadCompiler.compileComponentsForEntities(componentsObject),

	// command buffer methods
	addComponent: (entityId, payload, layer) => commandBuffer.addComponent(entityId, payload, layer),
	addComponents: (entityId, payload, layer) => commandBuffer.addComponents(entityId, payload, layer),

	setComponent: (entityId, payload, layer) => commandBuffer.setComponent(entityId, payload, layer),
	setComponentSilent: (entityId, payload, layer) => commandBuffer.setComponentSilent(entityId, payload, layer),

	setComponents: (entityId, payload, layer) => commandBuffer.setComponents(entityId, payload, layer),
	setComponentsSilent: (entityId, payload, layer) => commandBuffer.setComponentsSilent(entityId, payload, layer),

	// --- Enableable Component Pattern Helpers ---
	enableComponent: (chunkId, indexInChunk, componentTypeId) => entityMaskManager.enableComponent(chunkId, indexInChunk, componentTypeId),
	disableComponent: (chunkId, indexInChunk, componentTypeId) => entityMaskManager.disableComponent(chunkId, indexInChunk, componentTypeId),
	enableComponentById: (entityId, componentTypeId) => entityMaskManager.enableComponentById(entityId, componentTypeId),
	disableComponentById: (entityId, componentTypeId) => entityMaskManager.disableComponentById(entityId, componentTypeId),
	createScratchBuffer: () => new Uint32Array(MAX_CHUNK_CAPACITY),
	isComponentEnabled: (chunkId, indexInChunk, componentTypeId) => entityMaskManager.isComponentEnabled(chunkId, indexInChunk, componentTypeId),
	getEnabled: (chunkId, componentTypeId, outBuffer) => entityMaskManager.getEnabled(chunkId, componentTypeId, outBuffer),

	// --- Dirty Tracking Component Pattern Helpers ---
	// Broad-phase: Marks the entire component type as dirty for a chunk. Call this ONCE per chunk, outside the entity loop.
	markComponentDirty: (chunkId, componentTypeId, tick) => entityManager.markComponentDirty(chunkId, componentTypeId, tick),

	// Narrow-phase: Marks a specific entity as dirty. Call this inside an entity loop for `isTrackable` components.
	markEntityDirty: (chunkId, indexInChunk, componentTypeId, tick) =>
		entityMaskManager.maskDirty(chunkId, indexInChunk, componentTypeId, tick),
	markEntityDirtyById: (entityId, componentTypeId, tick) => entityMaskManager.maskDirtyById(entityId, componentTypeId, tick),

	markEntitiesDirty: (chunkId, indexInChunk, componentTypeIds, tick) =>
		entityMaskManager.markEntitiesDirty(chunkId, indexInChunk, componentTypeIds, tick),
	markEntitiesDirtyById: (entityId, componentTypeIds, tick) =>
		entityMaskManager.markEntitiesDirtyById(entityId, componentTypeIds, tick),

	// Querying for dirty entities (narrow-phase).
	getDirty: (chunkId, componentTypeId, lastTick, currentTick, outBuffer) =>
		entityMaskManager.getDirty(chunkId, componentTypeId, lastTick, currentTick, outBuffer),

	removeComponent: (entityId, componentTypeId, layer) =>
		commandBuffer.removeComponent(entityId, componentTypeId, layer),

	destroyEntity: (entityId, layer) => commandBuffer.destroyEntity(entityId, layer),
	destroyByQuery: (query, layer) => commandBuffer.destroyByQuery(query, layer),
	destroyEntitiesInChunk: (chunkId, layer) => commandBuffer.destroyEntitiesInChunk(chunkId, layer),
	createEntity: (payload, layer) => commandBuffer.createEntity(payload, layer),
	createEntities: (payload, count, layer) => commandBuffer.createEntities(payload, count, layer),
	instantiate: (payload, layer) => commandBuffer.instantiate(payload, layer),

	// Query-related helpers
	getComponentData: (chunkId, componentTypeId) => entityStore.chunkComponentData[chunkId][componentTypeId],
	getChunkSize: chunkId => entityStore.chunkSizes[chunkId],
	getEntities: chunkId => entityStore.chunkComponentData[chunkId].entities,
	getComponentTypeIDsForArchetype: archetypeId => entityManager.getComponentTypeIDsForArchetype(archetypeId),

	//query
	getQuery: options => queryManager.getQuery(options),

	// entity manager
	getEntityLocation: entityId => entityManager.getEntityLocation(entityId),

	//! Not recommended unless absolutely nessesary
	// This is a footgun for tests/HMR. If no tick is provided, it defaults to 0.
	// A timestamp of 0 will be seen by the first tick's reactive query (`dirtyTick > -1`),
	// but may cause issues if used mid-loop. Use with caution.
	//todo use tick from system manager there.
	flush: timestampTick => commandBuffer.flush(timestampTick ?? 0),
}
