const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager, prefabManager, sharedDataManager } = ecs

const { entityStore } = await import(`${PATH_ECS}/EntityManager/EntityManager.js`)

const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

/**
 * This system is the first step in the action pipeline. It finds an entity's
 * currently active item and triggers its effects if the entity has an `ActionIntent`.
 * It is a **reactive** system that only processes entities whose `ActionIntent` has changed.
 */
export class ItemEventSystem {
	constructor() {
		const { actionIntent, activeSet, prefab, cooldown, activeCooldown } = ecs.getTypeIDs()
		Object.assign(this, { actionIntent, activeSet, prefab, cooldown, activeCooldown })

		this.actorsQuery = queryManager.getQuery({ with: [actionIntent, activeSet], react: [actionIntent] })
		this.cooldownsQuery = queryManager.getQuery({ with: [activeCooldown] })

		this.prefabManager = prefabManager
		this.sharedDataManager = sharedDataManager
		this.entityManager = ecs.entityManager

		// Pre-compile the payload for creating new Cooldown entities.
		this.cooldownCreationPayload = payloadCompiler.compileEntity({ activeCooldown: {} })
	}

	init() {}

	update({deltaTime, currentTick, lastTick}) {
		for (const chunk of this.actorsQuery.iter()) {
			const actionIntents = chunk.componentData[this.actionIntent]
			const activeSets = chunk.componentData[this.activeSet]
			const actionIntentDirtyTicks = chunk.dirtyTicks[this.actionIntent]

			const intents = actionIntents.actionIntent
			const activeIndices = activeSets.activeSlotIndex
			let wasModified = false

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (!chunk.hasChanged(this.actionIntent, indexInChunk)) {
					continue
				}

				// We only care about the intent to *start* an action (value becomes 1).
				if (intents[indexInChunk] !== 1) {
					continue
				}

				const actorId = chunk.entities[indexInChunk]

				// The intent has been seen, so we clear it immediately by modifying the component data directly.
				intents[indexInChunk] = 0
				actionIntentDirtyTicks[indexInChunk] = currentTick
				wasModified = true

				const activeSlotIndex = activeIndices[indexInChunk]
				// Access the flattened array property directly.
				const itemEntityId = activeSets[`slots${activeSlotIndex}`][indexInChunk]

				if (!itemEntityId) {
					continue
				}

				// Get item's components to check for cooldown.
				const itemArchetypeId = this.entityManager.getArchetypeForEntity(itemEntityId)
				if (itemArchetypeId === undefined) continue

				const itemLocation = this.entityManager.getEntityLocation(itemEntityId)
				if (!itemLocation) continue

				const { chunkId: itemChunkId, indexInChunk: itemIndexInChunk } = itemLocation

				// Get PrefabId first, as it's needed for logging and cooldowns.
				const prefabIdArrays = entityStore.chunkComponentData[itemChunkId][this.prefab]
				if (!prefabIdArrays) {
					console.warn(`ItemEventSystem: Item ${itemEntityId} is missing a Prefab component. Cannot process action.`)
					continue
				}

				// 1. Get the prototypeId from the entity's Prefab component.
				const prototypeId = prefabIdArrays.prototypeId[itemIndexInChunk]
				// 2. Get the prototype object from the prototypeStore.
				const prototype = this.sharedDataManager.prototypeStore[prototypeId]
				// 3. Get the sharedDataIndex for the Prefab component from the prototype.
				const sharedPrefabDataIndex = prototype?.[this.prefab]
				// 4. Get the actual value from the valueStore.
				const itemPrefabId = this.sharedDataManager.valueStores[this.prefab]?.id[sharedPrefabDataIndex]

				if (itemPrefabId === undefined) {
					console.warn(`ItemEventSystem: Could not resolve prefabId for item ${itemEntityId}. Cannot process action.`)
					continue
				}

				const cooldownArrays = entityStore.chunkComponentData[itemChunkId][this.cooldown]

				// Cooldown duration is now a shared property.
				if (cooldownArrays) {
					if (this.isOnCooldown(actorId, Number(itemPrefabId))) continue

					// We already have the prototype from the Prefab lookup. We can reuse it.
					const sharedCooldownDataIndex = prototype?.[this.cooldown]
					const itemCooldownDuration =
						this.sharedDataManager.valueStores[this.cooldown]?.duration[sharedCooldownDataIndex] ?? 0

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
			if (wasModified) chunk.markChunkDirty(this.actionIntent, currentTick)
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
			const cooldowns = chunk.componentData[this.activeCooldown]
			const ownerIds = cooldowns.ownerId
			const prefabIds = cooldowns.prefabId

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (ownerIds[indexInChunk] === ownerId && prefabIds[indexInChunk] === prefabId) return true
			}
		}
		return false
	}

	destroy() {}
}
