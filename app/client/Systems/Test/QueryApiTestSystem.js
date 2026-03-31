const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { position, queryTestTag } = ecs.getComponentIDs()

/**
 * A test system to validate the new Query API patterns, starting with
 * direct, non-generator-based chunk access.
 */
export class QueryApiTestSystem {
	init() {
		this.query = this.getQuery({
			with: [position, queryTestTag],
		})

		// Create some entities to iterate over
		for (let i = 0; i < 10; i++) {
			const { payload } = this.compile({
				position: { x: i * 10, y: i * 5 },
				queryTestTag: {},
			})

			this.createEntity(payload)
		}

		// Flush to ensure entities are created before the first update.
		this.flush()
	}

	update({ currentTick }) {
		const matchingArchetypeIds = this.query.getArchetypes()

		// --- Tier 1 "Stateless" API Example ---
		// This is the fastest path for simple loops, avoiding the ChunkView overhead.
		{
			const matchingChunkIds = this.query.getChunks()

			for (let i = 0; i < matchingChunkIds.length; i++) {
				const chunkId = matchingChunkIds[i]

				// It's good practice to check if the chunk is not empty.
				const chunkSize = this.getChunkSize(chunkId)

				// Get component data directly using the stateless helper.
				const positions = this.getComponentData(chunkId, position)

				// Perform work on the entities in this chunk.
				for (let j = 0; j < chunkSize; j++) {
					positions.x[j] += 0.1 // Pretend to read and write data.
				}

				// Mark the component as dirty for this chunk using the stateless helper.
				this.markChunkComponentDirty(chunkId, position, currentTick)
			}
		}
	}
}
