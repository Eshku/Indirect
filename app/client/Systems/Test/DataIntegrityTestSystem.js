const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()
const { churnTag, churnData, verification, position, velocity, rotation, componentA, componentB } = ecs.getComponentIDs()
const { dataIntegrity } = ecs.getKernelIDs()
/**
 * A critical data integrity test system designed to detect stale data and memory corruption
 * bugs within the ECS core, particularly those related to chunk memory recycling.
 *
 * --- How It Works ---
 * 1.  **Churn Generation**: The system alternates between a "Creation" phase and a "Destruction" phase to
 *     create intense "churn"—the rapid creation and destruction of entities. This forces the engine's
 *     memory manager to recycle chunk slots frequently, creating opportunities for stale data bugs to appear.
 *
 * 2.  **Data Ownership Verification (The Core Test)**: The `schedule` method runs in parallel on worker threads.
 *     - **Priming**: The first time a worker sees a new entity, it writes the entity's *actual ID* into the
 *       `churnData.entityId` field. This "primes" the data with an ownership signature.
 *     - **Verification**: On all subsequent frames, the worker compares the `entityId` stored in the component
 *       against the actual `entityId` for that slot in the chunk.
 *     - **Detection**: If the IDs do **not** match, it proves the component data is stale from a previous,
 *       destroyed entity that occupied the same memory slot. This is a data corruption bug. The entity is
 *       marked with a failure status in its `Verification` component.
 *
 * 3.  **Reporting**: The `process` method runs on the main thread. It periodically queries for any entities
 *     marked with a failure status and logs a detailed `DATA CORRUPTION DETECTED!` error to the console.
 */
export class DataIntegrityTestSystem {
	// --- System Dependencies for the Scheduler ---
	static dependencies = {
		dataIntegrity: {
			reads: [churnData, verification],
			writes: [churnData, verification],
			context: {
				churnData,
				verification,
			},
		},
		process: {
			reads: [verification, churnData],
		},
	}

	init() {
		// --- Test Configuration ---
		this.maxEntities = 2000
		this.creationBatchSize = 100
		this.destructionPercentage = 0.8 // Destroy 80% of entities each destruction phase

		this.creationPhaseDuration = 2.0 // seconds
		this.destructionPhaseDuration = 0.5 // seconds
		this.phaseTimer = this.creationPhaseDuration
		this.isCreationPhase = true

		// --- Archetype Variant Setup for Resize Test ---
		// This list of component combinations will be used to create a variety of unique
		// archetypes, forcing the SharedArchetypeHashMap to resize.
		this.archetypeVariantCounter = 0
		this.archetypeVariants = [
			{}, // Base archetype { churnTag, churnData, verification }
			{ position: {} }, // + position
			{ velocity: {} }, // + velocity
			{ rotation: {} }, // + rotation
			{ componentA: {} }, // + componentA
			{ componentB: {} }, // + componentB
			{ position: {}, velocity: {} }, // + position, velocity
			{ position: {}, rotation: {} }, // + position, rotation
		]

		// --- Queries ---
		this.churnQuery = this.getQuery({ with: [churnTag] })
		this.query = this.getQuery({ with: [churnTag, churnData, verification] })

		// --- Payloads ---
		this.verificationUpdatePayload = this.compile(
			{ verification: { status: 2 } }, // The data we want to set
		)

		console.log('[ChurnTest] System initialized. Starting in Creation phase.')
	}

	// Runs on the main thread, handles phase switching, entity creation/destruction, and visualization.
	update({ deltaTime, currentTick }) {
		// --- Phase Management ---
		this.phaseTimer -= deltaTime
		if (this.phaseTimer <= 0) {
			this.isCreationPhase = !this.isCreationPhase
			this.phaseTimer = this.isCreationPhase ? this.creationPhaseDuration : this.destructionPhaseDuration
		}

		// --- Execute Current Phase Logic ---
		if (this.isCreationPhase) {
			// Create new entities if we are below the max count.
			const currentCount = this.churnQuery.count
			if (currentCount < this.maxEntities) {
				// This loop now creates entities with different archetypes to trigger
				// the SharedArchetypeHashMap resize mechanism.
				for (let i = 0; i < this.creationBatchSize; i++) {
					const variantData = this.archetypeVariants[this.archetypeVariantCounter]
					const payload = this.compile({
						churnTag: {},
						churnData: { creationTick: currentTick, entityId: 0n },
						verification: { status: 0 },
						...variantData,
					})
					this.instantiate(payload, 1)

					this.archetypeVariantCounter = (this.archetypeVariantCounter + 1) % this.archetypeVariants.length
				}
			}
		} else {
			// Destroy a large portion of existing entities.
			const entitiesToDestroy = []
			const churnChunkIds = this.churnQuery.getChunks()
			for (let i = 0; i < churnChunkIds.length; i++) {
				const chunkId = churnChunkIds[i]
				const entities = this.getEntities(chunkId)
				for (let j = 0; j < this.getChunkSize(chunkId); j++) {
					if (Math.random() < this.destructionPercentage) {
						entitiesToDestroy.push(entities[j])
					}
				}
			}

			for (const entityId of entitiesToDestroy) {
				this.destroyEntity(entityId)
			}
		}
	}

	/**
	 * Schedules a data integrity check job for each relevant chunk.
	 * @param {import('../../Managers/SystemManager/JobWriter.js').JobWriter} jobWriter
	 */
	schedule(jobWriter) {
		jobWriter.scheduleForEachChunk(this.query, dataIntegrity)
	}

	// Runs on the main thread after parallel jobs. Reports any detected corruption.
	process({ currentTick }) {
		// Only run the check periodically to avoid log spam.
		if (currentTick % 60 !== 0) return

		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const verifications = this.getComponentData(chunkId, verification)
			const churnDataComponent = this.getComponentData(chunkId, churnData)
			const entities = this.getEntities(chunkId)

			for (let j = 0; j < this.getChunkSize(chunkId); j++) {
				// Check for failure status (-1) that hasn't been logged yet.
				if (verifications.status[j] === -1) {
					const entityId = entities[j]
					const storedEntityId = churnDataComponent.entityId[j]
					const storedTick = churnDataComponent.creationTick[j]

					console.error(`[ChurnTest] DATA CORRUPTION DETECTED!`, {
						entityId: entityId.toString(),
						location: ecs.entityManager.getEntityLocation(entityId),
						message: 'Component data does not belong to this entity. Stale data from a recycled chunk slot.',
						actualEntityId: entityId.toString(),
						storedEntityId: storedEntityId.toString(),
						storedCreationTick: storedTick,
					})

					// Mark as logged to prevent spamming the console every frame for the same error.
					this.setComponent(entityId, this.verificationUpdatePayload)
				}
			}
		}
	}

	destroy() {
		// HMR Cleanup: Destroy all entities created by this system.
		const chunkIds = this.churnQuery.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			this.destroyEntitiesInChunk(chunkIds[i])
		}
	}
}
