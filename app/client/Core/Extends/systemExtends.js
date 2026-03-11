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
	removeComponent: commandBuffer.removeComponent.bind(commandBuffer),
	destroyEntity: commandBuffer.destroyEntity.bind(commandBuffer),
	destroyEntitiesInChunk: commandBuffer.destroyEntitiesInChunk.bind(commandBuffer),
	createEntity: commandBuffer.createEntity.bind(commandBuffer),
	createEntities: commandBuffer.createEntities.bind(commandBuffer),
	instantiate: commandBuffer.instantiate.bind(commandBuffer),

	//! Use only for tests / debug / when nessesary.
	flush: commandBuffer.flush.bind(commandBuffer),

	//query
	getQuery: queryManager.getQuery.bind(queryManager),
	
	//todo rename it better on both sides, it is to get simple entity component.
	//getEntityComponent? idk
	getComponent: entityManager.getComponent.bind(entityManager),
}
