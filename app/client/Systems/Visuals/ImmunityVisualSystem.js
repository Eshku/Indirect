const { engine } = await import(`@client/Engine.js`)
const { ecs, assetManager } = engine.getManagers()

const { immunity, tint, playerTag, position, shieldTag } = ecs.getComponentIDs()
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
	static runsAfter = [SpriteFactorySystem, RenderLayerSystem]

	static dependencies = {
		update: {
			reads: [playerTag, immunity, position],
			writes: [tint, position],
		},
	}

	init() {
		// Query for the player to read their position and invulnerability state.
		this.playerQuery = this.getQuery({
			with: [playerTag, immunity, position],
		})

		// Query for the shield entity to write to its position and tint.
		this.shieldQuery = this.getQuery({
			with: [shieldTag, tint, position],
		})

		// A flag to track if the shield was visible on the previous frame.
		// This is used to detect when to hide the shield.
		this.isShieldVisible = false
	}

	update({ deltaTime, currentTick }) {
		// These are singleton queries. Because the entities are created at startup,
		// we can use the getSingleChunk() convenience method.
		const playerChunk = this.playerQuery.getSingleChunk()
		const shieldChunk = this.shieldQuery.getSingleChunk()

		const isImmune = playerChunk.isComponentEnabled(0, immunity)

		if (isImmune) {
			const immunities = playerChunk.componentData[immunity]
			const playerPositions = playerChunk.componentData[position]
			const shieldPositions = shieldChunk.componentData[position]
			const shieldTints = shieldChunk.componentData[tint]

			// Sync shield position with player position for visual effect.
			// This is a data-driven approach. SyncTransforms will handle the visual update.
			shieldPositions.x[0] = playerPositions.x[0]
			shieldPositions.y[0] = playerPositions.y[0]

			// Calculate alpha based on remaining immunity duration.
			const progress = immunities.timer[0] / immunities.duration[0]
			shieldTints.a[0] = progress
			shieldChunk.markEntityDirty(0, tint, currentTick)

			this.isShieldVisible = true
		} else if (this.isShieldVisible) {
			// Invulnerability just ended.
			shieldChunk.componentData[tint].a[0] = 0.0
			shieldChunk.markEntityDirty(0, tint, currentTick)
			this.isShieldVisible = false
		}
	}
}
