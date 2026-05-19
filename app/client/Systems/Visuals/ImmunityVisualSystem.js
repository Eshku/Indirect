const { engine } = await import(`@client/Engine.js`)
const { ecs, assetManager } = engine.getManagers()

const { immunity, tint, visibility, playerTag, position, shieldTag } = ecs.getComponentIDs()
const { SyncTransforms, SpriteFactorySystem, RenderLayerSystem } = ecs.getSystemIDs()

/**
 * Manages the visual representation of the player's invulnerability shield.
 * It reacts to the player's `invulnerability` component state to position
 * and fade the shield entity.
 *
 * This system ensures the shield entity's position matches the player's position
 * and controls its visibility (alpha) based on the invulnerability timer.
 * The long-term solution for positioning is a proper entity hierarchy system
 * (see Hierarchies.md), but this approach is a clean, data-driven intermediate.
 */
export class ImmunityVisualSystem {
	static runsBefore = [SyncTransforms]

	static dependencies = {
		update: {
			reads: [playerTag, immunity, position, visibility],
			writes: [tint, position, visibility],
		},
	}

	init() {
		// Query for the player to read their position and invulnerability state.
		this.playerQuery = this.getQuery({
			with: [playerTag, immunity, position],
		})

		// Query for the shield entity to write to its position and tint.
		this.shieldQuery = this.getQuery({
			with: [shieldTag, tint, position, visibility],
		})
	}

	update({ deltaTime }) {
		const playerChunkIds = this.playerQuery.getChunks()
		const shieldChunkIds = this.shieldQuery.getChunks()
		// This system assumes a single player and a single shield entity exist.
		if (playerChunkIds.length === 0 || shieldChunkIds.length === 0) return

		const playerChunkId = playerChunkIds[0]
		const shieldChunkId = shieldChunkIds[0]

		const isImmune = this.isComponentEnabled(playerChunkId, 0, immunity)

		const shieldPositions = this.getComponentData(shieldChunkId, position)
		const shieldTints = this.getComponentData(shieldChunkId, tint)
		const shieldVisibilities = this.getComponentData(shieldChunkId, visibility)

		let targetAlpha = 0.0
		let targetVisibility = 0

		if (isImmune) {
			const immunities = this.getComponentData(playerChunkId, immunity)
			const playerPositions = this.getComponentData(playerChunkId, position)

			// Sync shield position with player position.
			shieldPositions.x[0] = playerPositions.x[0]
			shieldPositions.y[0] = playerPositions.y[0]

			// Calculate alpha based on remaining immunity duration.
			targetAlpha = immunities.timer[0] / immunities.duration[0]
			targetVisibility = 1
		}

		shieldTints.a[0] = targetAlpha
		this.markEntityDirty(shieldChunkId, 0, tint)
		this.markComponentDirty(shieldChunkId, tint)

		shieldVisibilities.isVisible[0] = targetVisibility
		this.markEntityDirty(shieldChunkId, 0, visibility)
		this.markComponentDirty(shieldChunkId, visibility)
	}
}
