/**
 * A kernel for the DataIntegrityTestSystem.
 * It verifies that the entity ID stored in a component matches the actual entity ID
 * for that slot, detecting stale data from recycled chunks.
 * @param {number} payload - For this kernel, the payload is the chunkId to process.
 * @param {object} systemContext - A read-only object with properties from the main-thread System instance.
 * @param {object} kernelContext - An object with thread-specific helpers.
 */
export function dataIntegrity(payload, systemContext, kernelContext) {
	const { churnData, verification } = systemContext

	const chunkId = payload
	const entities = self.kernel.getEntities(chunkId)
	const churnDataArr = self.kernel.getComponentData(chunkId, churnData)
	const verifications = self.kernel.getComponentData(chunkId, verification)
	const chunkSize = self.kernel.getChunkSize(chunkId)

	for (let i = 0; i < chunkSize; i++) {
		// Only process entities that haven't already failed verification.
		if (verifications.status[i] === -1) continue

		const storedEntityId = churnDataArr.entityId[i]
		const actualEntityId = entities[i]

		if (storedEntityId === 0n) {
			// Prime the entity with its actual ID.
			churnDataArr.entityId[i] = actualEntityId
			verifications.status[i] = 1
		} else if (storedEntityId !== actualEntityId) {
			// Stored ID doesn't match the entity in this slot. Corruption!
			verifications.status[i] = -1
		}
	}
}