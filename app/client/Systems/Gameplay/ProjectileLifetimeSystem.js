const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { playerProjectile, velocity, range, distanceTraveled, lifecycleState, visibility, tint } = ecs.getComponentIDs()
const LIFECYCLE = ecs.getConstantsForProperty(lifecycleState, 'state')

/**
 * Manages the lifecycle of projectiles with a limited range.
 * It updates their distance traveled and marks them as 'DYING' when they exceed their range.
 */
export class ProjectileLifetimeSystem {
	static dependencies = {
		update: {
			reads: [velocity, range],
			writes: [distanceTraveled, lifecycleState, visibility, tint],
		},
	}

	init() {
		this.query = this.getQuery({
			with: [playerProjectile, velocity, range, distanceTraveled, lifecycleState, visibility, tint],
		})
		this.isActiveMaskId = this.getMaskId('isActive')
		this.isDeadMaskId = this.getMaskId('isDead')
		this.scratchBuffer = this.createScratchBuffer()
	}

	update({ deltaTime }) {
		const chunkIds = this.query.getChunks()

		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const velocities = this.getComponentData(chunkId, velocity)
			const ranges = this.getComponentData(chunkId, range)
			const distances = this.getComponentData(chunkId, distanceTraveled)
			const states = this.getComponentData(chunkId, lifecycleState)
			const visibilities = this.getComponentData(chunkId, visibility)
			const tints = this.getComponentData(chunkId, tint)
			let wasChunkModified = false

			const activeCount = this.getIndicesFromMask(this.isActiveMaskId, chunkId, this.scratchBuffer)
			for (let j = 0; j < activeCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				const speed = Math.sqrt(velocities.x[indexInChunk] ** 2 + velocities.y[indexInChunk] ** 2)
				distances.value[indexInChunk] += speed * deltaTime

				if (distances.value[indexInChunk] >= ranges.value[indexInChunk]) {
					// Projectiles are instantly pooled, they do not have a death animation.
					// We transition them from ACTIVE to DEAD for the PoolingSystem to handle.
					this.clearBit(this.isActiveMaskId, chunkId, indexInChunk)
					this.setBit(this.isDeadMaskId, chunkId, indexInChunk)
					states.state[indexInChunk] = LIFECYCLE.DEAD

					// Also make them invisible and reset their tint immediately.
					visibilities.isVisible[indexInChunk] = 0
					tints.r[indexInChunk] = 1.0
					tints.g[indexInChunk] = 1.0
					tints.b[indexInChunk] = 1.0
					tints.a[indexInChunk] = 1.0

					this.markEntityDirty(chunkId, indexInChunk, lifecycleState)
					this.markEntityDirty(chunkId, indexInChunk, visibility)
					this.markEntityDirty(chunkId, indexInChunk, tint)
					wasChunkModified = true
				}
			}

			if (wasChunkModified) {
				this.markComponentDirty(chunkId, lifecycleState)
				this.markComponentDirty(chunkId, visibility)
				this.markComponentDirty(chunkId, tint)
			}
		}
	}
}
