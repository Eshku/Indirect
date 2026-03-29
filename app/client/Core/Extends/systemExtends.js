const { payloadCompiler } = await import(`@managers/SystemManager/PayloadCompiler.js`)
const { commandBuffer } = await import(`@managers/SystemManager/CommandBuffer.js`)
const { queryManager } = await import(`@managers/QueryManager/QueryManager.js`)
const { entityManager } = await import(`@managers/EntityManager/EntityManager.js`)

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
	compile: payloadCompiler.compile.bind(payloadCompiler),
	compileComponentsForEntities: payloadCompiler.compileComponentsForEntities.bind(payloadCompiler),

	// command buffer methods
	addComponent: commandBuffer.addComponent.bind(commandBuffer),
	addComponents: commandBuffer.addComponents.bind(commandBuffer),
	setComponentData: commandBuffer.setComponentData.bind(commandBuffer),
	setComponentDataSilent: commandBuffer.setComponentDataSilent.bind(commandBuffer),
	setComponentsData: commandBuffer.setComponentsData.bind(commandBuffer),
	setComponentsDataSilent: commandBuffer.setComponentsDataSilent.bind(commandBuffer),
	enableComponent: commandBuffer.enableComponent.bind(commandBuffer),
	disableComponent: commandBuffer.disableComponent.bind(commandBuffer),
	removeComponent: commandBuffer.removeComponent.bind(commandBuffer),
	destroyEntity: commandBuffer.destroyEntity.bind(commandBuffer),
	destroyEntitiesInChunk: commandBuffer.destroyEntitiesInChunk.bind(commandBuffer),
	createEntity: commandBuffer.createEntity.bind(commandBuffer),
	createEntities: commandBuffer.createEntities.bind(commandBuffer),
	instantiate: commandBuffer.instantiate.bind(commandBuffer),

	// Advanced API: Manually marks a component as dirty.
	// Most changes are tracked automatically via `setComponentData`. This is only needed
	// for indirect changes (e.g., a `Hierarchy` component whose child is destroyed).
	markDirty: commandBuffer.markDirty.bind(commandBuffer),



	//query
	getQuery: queryManager.getQuery.bind(queryManager),
	getScratchBuffer: queryManager.getScratchBuffer.bind(queryManager),

	// entity manager
	getEntityLocation: entityManager.getEntityLocation.bind(entityManager),


	//! Not recommended unless absolutely nessesary
	//! could be used as additional command buffer execution system
	//! could be usefull for tests \ debug.
	flush: commandBuffer.flush.bind(commandBuffer),
}
