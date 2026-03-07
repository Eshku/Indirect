const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()

const { activeCooldown } = ecs.getTypeIDs()

/**
 * Updates all active cooldowns in the world. This system embodies the "cooldown-as-an-entity" pattern.
 *
 * --- How It Works (Cooldown-as-an-Entity) ---
 *
 * Instead of storing cooldowns in a manager or on the owner entity, this architecture
 * treats each active cooldown as its own, temporary entity.
 *
 * 1.  **Creation:** When a skill is used, `ItemEventSystem` queues a command to create a new entity
 *     with a single `ActiveCooldown` component. This component stores the `ownerId`, the `prefabId`
 *     of the skill, and the `remainingTime`.
 *
 * 2.  **Update (This System):** The `CooldownSystem` runs on the fixed 'logic' timestep. It performs
 *     a single, highly-efficient query for all entities with an `ActiveCooldown` component. It then
 *     iterates through this tightly packed data, decrementing the `remainingTime` for each one.
 *
 * 3.  **Destruction:** When a cooldown's `remainingTime` drops to zero or below, this system queues
 *     a `destroyEntity` command. The cooldown entity is then removed from the world.
 *
 * --- Performance Considerations ---
 *
 * - **PRO (Fast Updates):** The update loop is extremely fast. It iterates over a single, contiguous
 *   array of `remainingTime` values, which is ideal for CPU cache performance (SoA layout).
 *
 * - **CON (Entity Churn):** This approach creates and destroys a large number of entities. This "churn"
 *   adds overhead to the `CommandBufferExecutor`, as it must process thousands of creation and
 *   destruction commands.
 *
 * - **CON (Slow Reads):** Checking if a *specific* skill is on cooldown requires iterating through *all*
 *   active cooldown entities in the game (an O(N) operation). This is acceptable for infrequent checks
 *   (like in `ItemEventSystem`) but would be too slow for a system that needs to check cooldowns every frame.
 *
 * --- Future Architecture: Packed Arrays ---
 *
 * The current "cooldown-as-an-entity" model is a temporary solution. Its high entity churn will become a
 * major performance bottleneck at scale. The long-term, optimal solution is to use **Packed Arrays**.
 *
 * In this future architecture, different types of temporary states will be managed by their own
 * dedicated components, each leveraging a `packed_array` for efficiency and flexibility.
 *
 * 1.  **`ActiveCooldowns` Component:** An owner entity (e.g., a player) will have this component. It will
 *     contain a `packed_array` of its active cooldowns: `{ prefabId, remainingTime }`. This is the
 *     direct replacement for the current "cooldown-as-an-entity" model.
 *
 * 2.  **`ActiveStatusEffects` Component:** A separate component would manage buffs and debuffs, containing
 *     its own `packed_array` of status effects: `{ effectType, magnitude, remainingTime }`.
 *
 * 3.  **Zero Churn:** In this model, starting a cooldown becomes a fast `packedArray.push()` command on the
 *     `ActiveCooldowns` component. This is a simple data write, **completely eliminating entity churn**.
 *
 * This specialized, multi-component approach provides the best of all worlds: zero churn, excellent read
 * performance (iterating a small, local list), and good update performance.
 */
export class CooldownSystem {
	init() {
		this.cooldownsQuery = this.getQuery({
			with: activeCooldown,
		})
	}

	update({ deltaTime, currentTick, lastTick }) {
		for (const chunk of this.cooldownsQuery.iter()) {
			const remainingTimes = chunk.componentData[activeCooldown].remainingTime

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				remainingTimes[indexInChunk] -= deltaTime

				if (remainingTimes[indexInChunk] <= 0) this.commands.destroyEntity(chunk.entities[indexInChunk])
			}

			chunk.markAllDirty(activeCooldown, currentTick)
		}
	}

	destroy() {}
}
