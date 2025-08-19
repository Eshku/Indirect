const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, prefabManager, entityManager, archetypeManager } = theManager.getManagers()

const { ActionIntent, SharedCooldowns, PlayerTag, PrefabId, ActiveSet } = componentManager.getComponents()

/**
 * This system is the first step in the action pipeline. It finds an entity's
 * currently active item and triggers its effects if the entity has an `ActionIntent`.
 *
 * It performs the following checks and actions:
 * 1.  **Identifies the Item:** Reads the `ActionIntent` to determine which item in `ActiveItems` is being used.
 * 2.  **Checks Cooldowns:** Verifies if the item is on cooldown via the owner's `SharedCooldowns` component.
 * 3.  **Initiates Action:** If the item can be used, it logs the action to the console.
 * 4.  **Initiates Cooldown:** Updates the owner's `SharedCooldowns` to put the item on cooldown.
 *
 * **Note on Intent Handling:** This system does not consume or reset the `actionIntent` flag.
 * The flag represents the raw state of an input (e.g., mouse button held down) and is managed
 * by the input or AI system that sets it. This design allows an action to be re-triggered on
 * subsequent frames if the input is held and the action is off cooldown, and also allows
 * other systems (like UI) to react to the continuous intent.
 */
export class ItemEventSystem {
	constructor() {
		// Query for entities that can perform actions (e.g., the player). These are the "owners".
		// Now includes ActiveSet to directly find the active item without a separate query.
		this.actorsQuery = queryManager.getQuery({
			with: [PlayerTag, ActionIntent, SharedCooldowns, ActiveSet],
		})

		this.actionIntentTypeID = componentManager.getComponentTypeID(ActionIntent)
		this.sharedCooldownsTypeID = componentManager.getComponentTypeID(SharedCooldowns)
		this.activeSetTypeID = componentManager.getComponentTypeID(ActiveSet)

		// A cache to store direct references to the `slotsN` TypedArrays for each archetype.
		// This avoids repeated string-based property lookups inside the hot loop.
		// Map<Archetype, Array<Uint32Array>>
		this._archetypeSlotArraysCache = new Map()
	}

	init() {}

	update(deltaTime, currentTick) {
		for (const actorChunk of this.actorsQuery.iter()) {
			const actorArchetypeData = actorChunk.archetype
			const actionIntents = actorArchetypeData.componentArrays[this.actionIntentTypeID]
			const sharedCooldownsArr = actorArchetypeData.componentArrays[this.sharedCooldownsTypeID]
			const activeSets = actorArchetypeData.componentArrays[this.activeSetTypeID]

			const intents = actionIntents.actionIntent
			const activeIndices = activeSets.activeSlotIndex

			const cooldownsMarker = archetypeManager.getDirtyMarker(
				actorArchetypeData.id,
				this.sharedCooldownsTypeID,
				currentTick
			)

			// Get the cached array of `slotsN` TypedArrays for this archetype.
			let slotArrays = this._archetypeSlotArraysCache.get(actorArchetypeData)
			if (!slotArrays) {
				// If not cached, build it once and store it.
				slotArrays = []
				const activeSetInfo = componentManager.componentInfo[this.activeSetTypeID]
				const capacity = activeSetInfo.representations.slots.capacity
				for (let i = 0; i < capacity; i++) {
					slotArrays.push(activeSets[`slots${i}`])
				}
				this._archetypeSlotArraysCache.set(actorArchetypeData, slotArrays)
			}

			for (const actorEntityIndex of actorChunk) {
				if (!intents[actorEntityIndex]) continue

				const activeIndex = activeIndices[actorEntityIndex]
				if (activeIndex < 0) continue

				// Use the pre-cached array of TypedArrays for fast, dynamic indexing.
				const itemEntityId = slotArrays[activeIndex][actorEntityIndex]
				if (!itemEntityId || !entityManager.isEntityActive(itemEntityId)) continue

				// Now that we have the item's entity ID, we can get its components.
				const itemPrefabIdComp = entityManager.getComponent(itemEntityId, PrefabId)
				if (!itemPrefabIdComp) continue // Item exists but has no PrefabId, which is unexpected.

				// The PrefabId component stores an interned string.
				const itemPrefabId = itemPrefabIdComp.id.toString()

				// Check if the item is on cooldown for this actor.
				const sharedCooldowns = sharedCooldownsArr[actorEntityIndex] // This is a "cold" component instance
				if (sharedCooldowns.cooldowns.has(itemPrefabId)) continue

				// Get the item's static data from the prefab cache.
				const itemComponents = prefabManager.getComponents(itemPrefabId)
				if (!itemComponents) {
					continue // Prefab data not found.
				}

				//  Action is valid, proceed
				const ownerEntityId = actorArchetypeData.entities[actorEntityIndex]
				console.log(`Entity ${ownerEntityId} used item '${itemPrefabId}'.`)

				// Initiate cooldown if the item has one.
				const cooldownData = itemComponents.cooldown
				if (cooldownData && cooldownData.duration > 0) {
					// Use the string prefabId to set the cooldown.
					sharedCooldowns.cooldowns.set(itemPrefabId, cooldownData.duration)
					// Mark the component as dirty so other systems (like UI) can react.
					cooldownsMarker.mark(actorEntityIndex)
				}
			}
		}
	}
}
