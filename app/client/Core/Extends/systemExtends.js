const { payloadCompiler } = await import(`@managers/SystemManager/PayloadCompiler.js`)
const { commandBuffer } = await import(`@managers/SystemManager/CommandBuffer.js`)
const { queryManager } = await import(`@managers/QueryManager/QueryManager.js`)
const { entityManager } = await import(`@managers/EntityManager/EntityManager.js`)
const { ChunkView } = await import(`@managers/QueryManager/ChunkView.js`)
const { entityStore } = await import(`@managers/EntityManager/EntityManager.js`)

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
	compileComponentsForEntities: componentsObject => payloadCompiler.compileComponentsForEntities(componentsObject),

	// command buffer methods
	addComponent: (entityId, payload, layer) => commandBuffer.addComponent(entityId, payload, layer),

	addComponents: (entityId, payload, layer) => commandBuffer.addComponents(entityId, payload, layer),

	setComponentData: (entityId, payload, layer) => commandBuffer.setComponentData(entityId, payload, layer),

	setComponentDataSilent: (entityId, payload, layer) => commandBuffer.setComponentDataSilent(entityId, payload, layer),

	setComponentsData: (entityId, payload, layer) => commandBuffer.setComponentsData(entityId, payload, layer),

	setComponentsDataSilent: (entityId, payload, layer) =>
		commandBuffer.setComponentsDataSilent(entityId, payload, layer),

	enableComponent: (entityId, componentTypeId, layer) =>
		commandBuffer.enableComponent(entityId, componentTypeId, layer),

	disableComponent: (entityId, componentTypeId, layer) =>
		commandBuffer.disableComponent(entityId, componentTypeId, layer),

	removeComponent: (entityId, componentTypeId, layer) =>
		commandBuffer.removeComponent(entityId, componentTypeId, layer),

	destroyEntity: (entityId, layer) => commandBuffer.destroyEntity(entityId, layer),

	destroyEntitiesInChunk: (chunk, layer) => commandBuffer.destroyEntitiesInChunk(chunk, layer),

	createEntity: (payload, layer) => commandBuffer.createEntity(payload, layer),

	createEntities: (payload, count, layer) => commandBuffer.createEntities(payload, count, layer),
	
	instantiate: (payload, layer) => commandBuffer.instantiate(payload, layer),

	// Manually marks a component as dirty.
	// Most changes are tracked automatically via `setComponentData`. 
	// This is only needed for indirect changes
	markDirty: (entityId, componentTypeId, tick, layer) =>
		commandBuffer.markDirty(entityId, componentTypeId, tick, layer),

	// Query-related helpers
	getChunkView: () => new ChunkView(entityStore),

	getComponentData: (chunkId, componentTypeId) => entityStore.chunkComponentData[chunkId][componentTypeId],
	getChunkSize: chunkId => entityStore.chunkSizes[chunkId],
	getEntities: chunkId => entityStore.chunkComponentData[chunkId].entities,

	//query
	getQuery: options => queryManager.getQuery(options),
	getScratchBuffer: componentTypeId => queryManager.getScratchBuffer(componentTypeId),

	// entity manager
	getEntityLocation: entityId => entityManager.getEntityLocation(entityId),
	// Immediate-mode dirty marking for use with the stateless API.
	markComponentDirty: (chunkId, componentTypeId, tick) =>
		entityManager.markComponentDirty(chunkId, componentTypeId, tick),

	//! Not recommended unless absolutely nessesary

	flush: () => commandBuffer.flush(),
}
