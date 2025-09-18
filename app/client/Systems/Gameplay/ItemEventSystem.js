const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, archetypeManager, entityManager, prefabManager } = theManager.getManagers()

const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

const { propertyGroupManager } = await import(`${PATH_INDIRECT}/PropertyGroupManager/PropertyGroupManager.js`)

/**
 * This system is the first step in the action pipeline. It finds an entity's
 * currently active item and triggers its effects if the entity has an `ActionIntent`.
 * It is a **reactive** system that only processes entities whose `ActionIntent` has changed.
 */
export class ItemEventSystem {
	constructor() {
		const { actionIntent, activeSet, prefab, cooldown, activeCooldown } = componentManager.getTypeIDs()
		Object.assign(this, { actionIntent, activeSet, prefab, cooldown, activeCooldown })

		this.actorsQuery = queryManager.getQuery({ with: [actionIntent, activeSet], react: [actionIntent] })
		this.cooldownsQuery = queryManager.getQuery({ with: [activeCooldown] })

		this.archetypeManager = archetypeManager
		this.prefabManager = prefabManager
		this.propertyGroupManager = propertyGroupManager
		this.entityManager = entityManager

		// Pre-compile the payload for creating new Cooldown entities.
		this.cooldownCreationPayload = payloadCompiler.compileEntity({ activeCooldown: {} })
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
					if (this.isOnCooldown(actorId, Number(itemPrefabId))) continue

					// We already have the sharedGroup from the Prefab lookup. We can reuse it.
					const sharedCooldownData = sharedGroup?.[this.cooldown]
					const itemCooldownDuration = sharedCooldownData?.duration ?? 0

					// Use the pre-compiled payload and mutators for efficient entity creation.
					const { payload, mutators } = this.cooldownCreationPayload
					// CRITICAL FIX: Convert BigInts to Numbers before assigning to TypedArray mutators.
					// `ownerId` is an 'entity' (BigInt), and `prefabId` is also being read as a BigInt from shared data.
					mutators.activeCooldown.ownerId[0] = actorId // This is a BigUint64Array, so it takes a BigInt directly.
					mutators.activeCooldown.prefabId[0] = Number(itemPrefabId)
					mutators.activeCooldown.remainingTime[0] = itemCooldownDuration

					this.commands.createEntity(payload)
				}

				const itemPrefabName = this.prefabManager.getPrefabNameById(itemPrefabId) // Explicitly convert BigInts to strings for logging.
				console.log(`Entity ${actorId.toString()} used ${itemPrefabName} with ID ${itemEntityId.toString()}`)
			}
		}
	}

	/**
	 * Checks if a specific owner/prefab combination is currently on cooldown.
	 * NOTE: This is an O(N) operation over all active cooldowns. It's acceptable
	 * here because it only runs when a player *tries* to use an item, not every frame.
	 * @param {bigint} ownerId The entity to check.
	 * @param {number} prefabId The skill/item prefab to check.
	 * @returns {boolean} True if a matching cooldown entity exists.
	 * @private
	 */
	isOnCooldown(ownerId, prefabId) {
		for (const chunk of this.cooldownsQuery.iter()) {
			const cooldowns = chunk.componentArrays[this.activeCooldown]
			const ownerIds = cooldowns.ownerId
			const prefabIds = cooldowns.prefabId

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (ownerIds[indexInChunk] === ownerId && prefabIds[indexInChunk] === prefabId) return true
			}
		}
		return false
	}
}
