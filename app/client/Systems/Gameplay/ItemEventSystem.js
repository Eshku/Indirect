const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, archetypeManager, entityManager, prefabManager } = theManager.getManagers()

const { cooldownManager } = await import(`${PATH_SUBSYSTEMS}/CooldownManager.js`)

const { propertyGroupManager } = await import(`${PATH_INDIRECT}/PropertyGroupManager/PropertyGroupManager.js`)

/**
 * This system is the first step in the action pipeline. It finds an entity's
 * currently active item and triggers its effects if the entity has an `ActionIntent`.
 * It is a **reactive** system that only processes entities whose `ActionIntent` has changed.
 */
export class ItemEventSystem {
	constructor() {
		const { actionIntent, activeSet, prefab, cooldown } = componentManager.getTypeIDs()
		Object.assign(this, { actionIntent, activeSet, prefab, cooldown })

		this.actorsQuery = queryManager.getQuery({ with: [actionIntent, activeSet], react: [actionIntent] })

		this.archetypeManager = archetypeManager
		this.cooldownManager = cooldownManager
		this.entityManager = entityManager
		this.prefabManager = prefabManager
		this.propertyGroupManager = propertyGroupManager
	}

	init() {}

	update(deltaTime, currentTick) {
		for (const chunk of this.actorsQuery.iter()) {
			const actionIntents = chunk.componentArrays[this.actionIntent]
			const activeSets = chunk.componentArrays[this.activeSet]
			const actionIntentMarker = chunk.getDirtyMarker(this.actionIntent, currentTick)

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
				// Access the flattened array property directly.
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
				const prefabIdArrays = itemChunk.componentArrays[this.prefab]
				if (!prefabIdArrays) {
					console.warn(`ItemEventSystem: Item ${itemEntityId} is missing a Prefab component. Cannot process action.`)
					continue
				}

				// The Prefab.id is now a shared property. We must look it up via the sharedGroupId.
				const prefabSharedGroupId = prefabIdArrays.sharedGroupId[itemIndexInChunk]
				const sharedGroup = this.propertyGroupManager.sharedGroups[prefabSharedGroupId]
				const sharedPrefabData = sharedGroup?.[this.prefab]
				const itemPrefabId = sharedPrefabData?.id

				if (itemPrefabId === undefined) {
					console.warn(`ItemEventSystem: Could not resolve prefabId for item ${itemEntityId}. Cannot process action.`)
					continue
				}

				const cooldownArrays = itemChunk.componentArrays[this.cooldown]

				// Cooldown duration is now a shared property.
				if (cooldownArrays) {
					if (this.cooldownManager.isOnCooldown(actorId, itemPrefabId)) continue

					// We already have the sharedGroup from the Prefab lookup. We can reuse it.
					const sharedCooldownData = sharedGroup?.[this.cooldown]
					const itemCooldownDuration = sharedCooldownData?.duration ?? 0
					this.cooldownManager.startCooldown(actorId, itemPrefabId, itemCooldownDuration)
				}

				const itemPrefabName = this.prefabManager.getPrefabNameById(itemPrefabId)
				console.log(`Entity ${actorId} used ${itemPrefabName} with ID ${itemEntityId}`)
			}
		}
	}
}
