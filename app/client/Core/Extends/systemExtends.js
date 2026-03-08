const { payloadCompiler } = await import(`@managers/SystemManager/PayloadCompiler.js`)
const { commandBuffer } = await import(`@managers/SystemManager/CommandBuffer.js`)
const { queryManager } = await import(`@managers/QueryManager/QueryManager.js`)

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
	// PayloadCompiler methods
	compileEntity: payloadCompiler.compileEntity.bind(payloadCompiler),
	compileEntities: payloadCompiler.compileEntities.bind(payloadCompiler),
	compileComponent: payloadCompiler.compileComponent.bind(payloadCompiler),
	compileComponents: payloadCompiler.compileComponents.bind(payloadCompiler),
	compileComponentsForEntities: payloadCompiler.compileComponentsForEntities.bind(payloadCompiler),

	commands: commandBuffer,
	getQuery: queryManager.getQuery.bind(queryManager),
}
