/**
 * @fileoverview Manages all shared cooldowns for entities.
 *
 * --- ARCHITECTURAL NOTES ---
 * This manager exists as a centralized, high-performance service for cooldowns,
 * a design chosen over several "purer" ECS alternatives due to specific game
 * requirements.
 *
 * ### Why not a "Service System"?
 * If this logic were placed in `CooldownSystem`, other systems like `ItemEventSystem`
 * and `HotbarSyncSystem` would need a direct reference to it to start and read
 * cooldowns. This would violate the core principle of system independence.
 *
 * ### Why not "Cooldown Entities"?
 * Creating a new entity for each active cooldown is a pure ECS pattern. However,
 * it introduces two significant performance problems. First, it requires constant
 * creation and destruction of entities, which is not a cheap.
 * Second, it makes "read" operations slower. To check if a specific
 * skill is on cooldown, a system would need to query and iterate through ALL
 * active cooldown entities in the game. This O(N) search is far too slow
 * compared to the O(1) Map lookup provided by this manager.
 *
 * ### Why not a "Cooldown Component" on the owner?
 * This was a strong contender, but it has a critical flaw: state persistence.
 * A cooldown must be tracked even if the item is moved from the hotbar to the
 * inventory. This means a component on the player would need a huge or dynamic
 * capacity to track cooldowns for every ownable item, which is inefficient.
 * This manager solves the problem by tracking cooldowns by `ownerId` and `prefabId`,
 * completely independent of item location or UI state.
 *
 * Therefore, this manager is a pragmatic choice that provides a decoupled,
 * O(1) performance solution that the pure ECS patterns could not.
 * ---------------------------
 *
 * This manager provides a centralized way to track cooldowns. It acts as a
 * passive data store, holding the `remainingTime` for any skill on cooldown.
 * The active logic for decrementing these timers is handled by the
 * `CooldownSystem`, which calls the `update` method on each logic tick.
 *
 * ### How It Works
 *
 * 1.  When a skill is used, `ItemEventSystem` calls `cooldownManager.startCooldown(playerId, skillPrefabId, duration)`.
 * 2.  The manager stores the `duration` as the initial `remainingTime`.
 * 3.  On every fixed logic tick, `CooldownSystem` calls `cooldownManager.update(deltaTime)`, which decrements all active timers.
 * 4.  Other systems, like `HotbarSyncSystem`, can call `cooldownManager.getRemaining()` to get the current, precise
 *     remaining time for UI display.
 */

class CooldownManager {
	constructor() {
		/**
		 * Maps an owner's entityId to their personal map of cooldowns.
		 * The inner map maps a skill's prefabId (as an interned string Ref) to its remaining time in seconds.
		 * @private
		 * @type {Map<number, Map<number, number>>}
		 */
		this.cooldownsByOwner = new Map()
		this.stringManager = null
	}

	async init() {
		const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
		const componentManager = theManager.getManager('ComponentManager')
		this.stringManager = componentManager.stringManager
	}

	/**
	 * Starts a cooldown for a specific entity and skill.
	 * @param {number} ownerId - The ID of the entity that owns the cooldown. * @param {number} prefabIdRef - The interned string reference for the skill's prefab ID.
	 * @param {number} duration - The cooldown duration in seconds.
	 */
	startCooldown(ownerId, prefabIdRef, duration) {
		if (!this.cooldownsByOwner.has(ownerId)) {
			this.cooldownsByOwner.set(ownerId, new Map())
		}
		const ownerCooldowns = this.cooldownsByOwner.get(ownerId)
		ownerCooldowns.set(prefabIdRef, duration)
	}

	/**
	 * Gets the remaining cooldown time for a specific entity and skill.
	 * @param {number} ownerId - The ID of the entity.
	 * @param {number} prefabIdRef - The interned string reference for the skill's prefab ID.
	 * @returns {number} The remaining time in seconds, or 0 if not on cooldown.
	 */
	getRemaining(ownerId, prefabIdRef) {
		const ownerCooldowns = this.cooldownsByOwner.get(ownerId)
		if (!ownerCooldowns) return 0

		return ownerCooldowns.get(prefabIdRef) || 0
	}

	isOnCooldown(ownerId, prefabIdRef) {
		return this.getRemaining(ownerId, prefabIdRef) > 0
	}

	/**
	 * Updates all active cooldowns by decrementing their remaining time.
	 * This is intended to be called by the CooldownSystem on each logic tick.
	 * @param {number} deltaTime - The time elapsed since the last logic tick.
	 */
	update(deltaTime) {
		for (const ownerCooldowns of this.cooldownsByOwner.values()) {
			for (const [prefabIdRef, remainingTime] of ownerCooldowns.entries()) {
				const newTime = remainingTime - deltaTime
				if (newTime <= 0) {
					ownerCooldowns.delete(prefabIdRef)
				} else {
					ownerCooldowns.set(prefabIdRef, newTime)
				}
			}
		}
	}
}

export const cooldownManager = new CooldownManager()