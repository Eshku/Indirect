const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { churnTag, churnData, verification } = ecs.getTypeIDs()
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

	constructor() {
		// --- Test Configuration ---
		this.maxEntities = 2000
		this.creationBatchSize = 100
		this.destructionPercentage = 0.8 // Destroy 80% of entities each destruction phase

		this.creationPhaseDuration = 2.0 // seconds
		this.destructionPhaseDuration = 0.5 // seconds
		this.phaseTimer = this.creationPhaseDuration
		this.isCreationPhase = true
	}

	init() {
		// --- Queries ---
		this.churnQuery = this.getQuery({ with: [churnTag] })
		this.query = this.getQuery({ with: [churnTag, churnData, verification] })

		// --- Payloads ---
		const { payload, mutators } = this.compiler.compileEntity({
			churnTag: {},
			churnData: { creationTick: 0, entityId: 0n }, // Initialize entityId to 0
			verification: { status: 0 }, // 0: unchecked, 1: ok, -1: fail, 2: logged
		})
		this.creationPayload = payload
		this.creationMutators = mutators

		const { payload: verificationPayload } = this.compiler.compileComponent(
			verification,
			{ status: 2 }, // The data we want to set
		)
		this.verificationUpdatePayload = verificationPayload

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
				for (let i = 0; i < this.creationBatchSize; i++) {
					this.creationMutators.churnData.creationTick[0] = currentTick
					// entityId is left as 0, to be primed by the 'schedule' job.

					this.commands.createEntity(this.creationPayload)
				}
			}
		} else {
			// Destroy a large portion of existing entities.
			const entitiesToDestroy = []
			for (const chunk of this.churnQuery.iter()) {
				for (let i = 0; i < chunk.size; i++) {
					if (Math.random() < this.destructionPercentage) {
						entitiesToDestroy.push(chunk.entities[i])
					}
				}
			}

			for (const entityId of entitiesToDestroy) {
				this.commands.destroyEntity(entityId)
			}
		}
	}

	schedule() {
		const jobs = []
		const chunkIds = this.query.getChunks()

		for (const chunkId of chunkIds) {
			jobs.push({
				kernel: dataIntegrity,
				payload: chunkId,
			})
		}
		return jobs
	}

	// Runs on the main thread after parallel jobs. Reports any detected corruption.
	process({ currentTick }) {
		// Only run the check periodically to avoid log spam.
		if (currentTick % 60 !== 0) return

		for (const chunk of this.query.iter()) {
			const verifications = chunk.componentData[verification]
			const churnDataComponent = chunk.componentData[churnData]
			const entities = chunk.entities

			for (let i = 0; i < chunk.size; i++) {
				// Check for failure status (-1) that hasn't been logged yet.
				if (verifications.status[i] === -1) {
					const entityId = entities[i]
					const storedEntityId = churnDataComponent.entityId[i]
					const storedTick = churnDataComponent.creationTick[i]

					console.error(`[ChurnTest] DATA CORRUPTION DETECTED!`, {
						entityId: entityId.toString(),
						location: ecs.entityManager.getEntityLocation(entityId),
						message: 'Component data does not belong to this entity. Stale data from a recycled chunk slot.',
						actualEntityId: entityId.toString(),
						storedEntityId: storedEntityId.toString(),
						storedCreationTick: storedTick,
					})

					// Mark as logged to prevent spamming the console every frame for the same error.
					this.commands.setComponentData(entityId, this.verificationUpdatePayload)
				}
			}
		}
	}

	destroy() {
		// HMR Cleanup: Destroy all entities created by this system.
		for (const chunk of this.churnQuery.iter()) {
			this.commands.destroyEntitiesInChunk(chunk)
		}
	}
}
