// Import the specific instances or factories you want to make available to all systems.
const { payloadCompiler } = await import('../../ECS/SystemManager/PayloadCompiler.js')
const { commandBuffer } = await import('../../ECS/SystemManager/CommandBuffer.js')
const { queryManager } = await import('../../Managers/QueryManager/QueryManager.js')

/**
 * A central configuration file for extending system instances.
 * Properties defined here will be directly assigned to every system instance
 * upon creation by the SystemManager.
 *
 * This implements the "Configurable Direct-Assignment Factory" pattern.
 */
export const extensions = {
	// The user requested this to be named 'compiler'.
	compiler: payloadCompiler,
	commands: commandBuffer,
	getQuery: queryManager.getQuery.bind(queryManager),
}