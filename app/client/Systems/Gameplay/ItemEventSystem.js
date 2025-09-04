const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, cooldownManager, archetypeManager, entityManager } = theManager.getManagers()

const { ActionIntent, PrefabId, ActiveSet, Cooldown } = componentManager.getComponents()

/**
 * This system is the first step in the action pipeline. It finds an entity's
 * currently active item and triggers its effects if the entity has an `ActionIntent`.
 * It is a **reactive** system that only processes entities whose `ActionIntent` has changed.
 */
export class ItemEventSystem {
	constructor() {
		this.actorsQuery = queryManager.getQuery({ with: [ActionIntent, ActiveSet], react: [ActionIntent] })

		this.actionIntentTypeID = componentManager.getComponentTypeID(ActionIntent)
		this.activeSetTypeID = componentManager.getComponentTypeID(ActiveSet)
		this.prefabIdTypeID = componentManager.getComponentTypeID(PrefabId)
		this.cooldownTypeID = componentManager.getComponentTypeID(Cooldown)
		this.stringStorage = componentManager.stringManager.storage

		this.archetypeManager = archetypeManager
		this.cooldownManager = cooldownManager
		this.entityManager = entityManager
	}

	init() {}

	update(deltaTime, currentTick) {
		for (const chunk of this.actorsQuery.iter()) {
			const actionIntents = chunk.componentArrays[this.actionIntentTypeID]
			const activeSets = chunk.componentArrays[this.activeSetTypeID]
			const actionIntentMarker = chunk.getDirtyMarker(this.actionIntentTypeID, currentTick)

			const intents = actionIntents.actionIntent
			const activeIndices = activeSets.activeSlotIndex

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (!this.actorsQuery.hasChanged(chunk, indexInChunk)) {
					continue
				}

				// We only care about the intent to *start* an action (value becomes 1).
				if (intents[indexInChunk] !== 1) {
					continue
				}

				const actorId = chunk.entities[indexInChunk]

				// The intent has been seen, so we clear it immediately by modifying the component data directly.
				intents[indexInChunk] = 0
				actionIntentMarker.mark(indexInChunk)

				const activeSlotIndex = activeIndices[indexInChunk]
				const itemEntityId = activeSets[`slots${activeSlotIndex}`][indexInChunk]

				if (!itemEntityId) {
					continue
				}

				// Get item's components to check for cooldown.
				const itemArchetypeId = this.entityManager.getArchetypeForEntity(itemEntityId)
				if (itemArchetypeId === undefined) continue

				const itemLocation = this.archetypeManager.archetypeEntityMaps[itemArchetypeId].get(itemEntityId)
				if (!itemLocation) continue

				const { chunk: itemChunk, indexInChunk: itemIndexInChunk } = itemLocation

				// Get PrefabId first, as it's needed for logging and cooldowns.
				const prefabIdArrays = itemChunk.componentArrays[this.prefabIdTypeID]
				if (!prefabIdArrays) {
					console.warn(`ItemEventSystem: Item ${itemEntityId} is missing a PrefabId component. Cannot process action.`)
					continue
				}

				const itemPrefabIdRef = prefabIdArrays.id[itemIndexInChunk]
				const itemPrefabIdString = this.stringStorage[itemPrefabIdRef]

				const cooldownArrays = itemChunk.componentArrays[this.cooldownTypeID]

				// Read cooldown value directly on the item if it is present.
				if (cooldownArrays) {
					if (this.cooldownManager.isOnCooldown(actorId, itemPrefabIdRef)) continue

					const itemCooldownDuration = cooldownArrays.duration[itemIndexInChunk]
					this.cooldownManager.startCooldown(actorId, itemPrefabIdRef, itemCooldownDuration)
				}

				console.log(`Entity ${actorId} used ${itemPrefabIdString} with ID ${itemEntityId}`)
			}
		}
	}
}
