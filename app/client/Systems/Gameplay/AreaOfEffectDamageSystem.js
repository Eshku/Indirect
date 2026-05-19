const { engine } = await import(`@client/Engine.js`)
const { ecs, physicsManager } = engine.getManagers()

const {
	areaOfEffectDamage,
	position,
	damage,
	damageable,
	damageCollisionBuffer,
	collisionLayer,
	lifecycleState,
} = ecs.getComponentIDs()

const { SpatialHashGrid } = await import(`@core/DataStructures/SpatialHashGrid.js`)
const LIFECYCLE = ecs.getConstantsForProperty(lifecycleState, 'state')

/**
 * Processes entities with `areaOfEffectDamage`, applying damage to other entities within a radius.
 * It integrates with the standard DamageSystem by writing to the targets' damageCollisionBuffer.
 */
export class AreaOfEffectDamageSystem {
	static dependencies = {
		update: {
			reads: [areaOfEffectDamage, position, damage, collisionLayer, lifecycleState],
			writes: [areaOfEffectDamage, damageCollisionBuffer],
		},
	}

	init() {
		// Query for one-shot AoE effects that haven't been applied yet.
		this.aoeQuery = this.getQuery({
			with: [areaOfEffectDamage, position, damage, lifecycleState],
		})

		// Get access to the spatial hash grid.
		const gridSABs = physicsManager.getSpatialHashGridSABs()
		this.grid = new SpatialHashGrid(gridSABs)

		// Reusable query result object.
		const MAX_AOE_RESULTS = 256
		this.gridQueryResult = {
			count: 0,
			capacity: MAX_AOE_RESULTS,
			entityIds: new BigUint64Array(MAX_AOE_RESULTS),
			chunkIds: new Uint16Array(MAX_AOE_RESULTS),
			entityIndices: new Uint16Array(MAX_AOE_RESULTS),
		}

		this.isActiveMaskId = this.getMaskId('isActive')
		this.scratchBuffer = this.createScratchBuffer()

		this.modifiedBufferChunks = new Set()
	}

	update() {
		this.modifiedBufferChunks.clear()

		const aoeChunkIds = this.aoeQuery.getChunks()
		for (let i = 0; i < aoeChunkIds.length; i++) {
			const chunkId = aoeChunkIds[i]
			const aoeEntities = this.getEntities(chunkId)
			const aoePositions = this.getComponentData(chunkId, position)
			const aoeDatas = this.getComponentData(chunkId, areaOfEffectDamage)

			const activeAoeCount = this.getIndicesFromMask(this.isActiveMaskId, chunkId, this.scratchBuffer)
			for (let j = 0; j < activeAoeCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				// Only process AoE effects that have not been applied yet.
				if (aoeDatas.hasApplied[indexInChunk] === 1) continue

				const aoeEntityId = aoeEntities[indexInChunk]
				const x = aoePositions.x[indexInChunk]
				const y = aoePositions.y[indexInChunk]
				const radius = aoeDatas.radius[indexInChunk]
				const mask = aoeDatas.mask[indexInChunk]

				// Find all entities within the radius.
				this.grid.queryRadius(x, y, radius, this.gridQueryResult)

				for (let k = 0; k < this.gridQueryResult.count; k++) {
					const targetId = this.gridQueryResult.entityIds[k]
					const targetChunkId = this.gridQueryResult.chunkIds[k]
					const targetIndexInChunk = this.gridQueryResult.entityIndices[k]

					if (targetId === aoeEntityId) continue

					if (!this.isBitSet(this.isActiveMaskId, targetChunkId, targetIndexInChunk)) continue

					if (!this.getComponentData(targetChunkId, damageable)) continue
					if (!this.getComponentData(targetChunkId, damageCollisionBuffer)) continue

					const targetLayers = this.getComponentData(targetChunkId, collisionLayer)
					const targetGroup = 1 << (targetLayers.group[targetIndexInChunk] - 1)
					if (!(targetGroup & mask)) continue

					this._writeToDamageBuffer(targetChunkId, targetIndexInChunk, aoeEntityId)
				}

				aoeDatas.hasApplied[indexInChunk] = 1
			}
		}

		for (const chunkId of this.modifiedBufferChunks) {
			this.markComponentDirty(chunkId, damageCollisionBuffer)
		}
	}

	_writeToDamageBuffer(chunkId, indexInChunk, damagerId) {
		const buffers = this.getComponentData(chunkId, damageCollisionBuffer)
		const count = buffers.count[indexInChunk]
		if (count >= 8) return

		buffers[`event${count}`][indexInChunk] = damagerId
		buffers.count[indexInChunk]++
		this.markEntityDirty(chunkId, indexInChunk, damageCollisionBuffer)
		this.modifiedBufferChunks.add(chunkId)
	}
}