const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { uiManager, queryManager, componentManager, prefabManager } = theManager.getManagers()

const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)
const { propertyGroupManager } = await import(`${PATH_INDIRECT}/PropertyGroupManager/PropertyGroupManager.js`)

const { stringInterningTable } = await import(`${PATH_INDIRECT}/StringInterningTable.js`)

const { HOTBAR_SLOT_COUNT } = await import(`${PATH_UI}/Hotbar.js`)

const { cooldownManager } = await import(`${PATH_SUBSYSTEMS}/CooldownManager.js`)

/**
 * Synchronizes the state of the player's hotbar with the Hotbar UI.
 */
export class HotbarSyncSystem {
	constructor() {
		const { owner, inActiveSet, prefab, icon, cooldown, playerTag, activeSet } = componentManager.getTypeIDs()
		Object.assign(this, { owner, inActiveSet, prefab, icon, cooldown, playerTag, activeSet })

		this.hotbarItemsQuery = queryManager.getQuery({
			with: [owner, inActiveSet, prefab, icon, cooldown],
		})
		// This query is for reacting to active slot changes in the update loop.
		this.playerUpdateQuery = queryManager.getQuery({
			// This query is now reactive. It will only process when the player's ActiveSet changes.
			with: [playerTag, activeSet],
			react: [activeSet],
		})
		// This query is for finding the player entity at startup.
		this.playerInitQuery = queryManager.getQuery({ with: [playerTag] })

		this.stringStorage = stringInterningTable.storage
		this.propertyGroupManager = propertyGroupManager
		this.cooldownManager = cooldownManager
		this.prefabManager = prefabManager
		this.playerId = null
		this.cachedSlotEntityIds = Array(HOTBAR_SLOT_COUNT).fill(0)
		this.cachedActiveSlot = -1

		// Pre-compile the payload for ActiveSet component updates.
		this.activeSetPayload = payloadCompiler.compileComponent(this.activeSet, { slots: [] })
		this.hotbar = null
	}

	init() {
		this.hotbar = uiManager.getElement('Hotbar')

		// Use the non-reactive query to reliably find the player at startup.
		for (const chunk of this.playerInitQuery.iter()) {
			this.playerId = chunk.entities[0]
			break
		}
		if (!this.playerId) console.error('HotbarSyncSystem: Could not find player entity!')

		this.update(0)
	}

	update(deltaTime) {
		const desiredState = Array(HOTBAR_SLOT_COUNT).fill(null)
		const desiredSlotEntityIds = Array(HOTBAR_SLOT_COUNT).fill(0)
		const stringStorage = this.stringStorage

		for (const chunk of this.hotbarItemsQuery.iter()) {
			const ownerArrays = chunk.componentArrays[this.owner]
			const inActiveSetArrays = chunk.componentArrays[this.inActiveSet]
			const prefabIdArrays = chunk.componentArrays[this.prefab]
			const iconArrays = chunk.componentArrays[this.icon]

			const ownerEntityIds = ownerArrays.entityId
			const slots = inActiveSetArrays.slot

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (ownerEntityIds[indexInChunk] !== this.playerId) {
					continue
				}

				const entityId = chunk.entities[indexInChunk]
				const slot = slots[indexInChunk]

				if (slot < HOTBAR_SLOT_COUNT) {
					// The Prefab component now has a sharedGroupId property on the chunk.
					const sharedGroupId = prefabIdArrays.sharedGroupId[indexInChunk]

					// Get the shared data block for this item.
					const sharedGroup = this.propertyGroupManager.sharedGroups[sharedGroupId]

					// Get the prefabId from the shared group.
					const sharedPrefabData = sharedGroup?.[this.prefab]
					const prefabId = sharedPrefabData?.id

					// The Icon's assetName is a per-entity property (though the string is interned).
					// We read its numeric reference directly from the chunk.
					const iconAssetNameRef = iconArrays.assetName[indexInChunk]
					const iconAssetStr = stringStorage[iconAssetNameRef]

					// The Cooldown.duration is a shared property.
					const sharedCooldownData = sharedGroup[this.cooldown]
					const totalDuration = sharedCooldownData?.duration ?? 0

					desiredState[slot] = {
						itemId: entityId,
						prefabId: prefabId,
						iconAsset: iconAssetStr, // This is the shared icon asset name
						totalDuration: totalDuration,
					}
					desiredSlotEntityIds[slot] = entityId
				}
			}
		}

		// --- Component & UI Sync ---
		// This section is optimized to only update the UI and component data when the
		// contents of the hotbar slots actually change.

		// First, check if any item IDs have changed since the last frame.
		let hasDataChanged = false
		for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
			if (this.cachedSlotEntityIds[i] !== desiredSlotEntityIds[i]) {
				hasDataChanged = true
				break
			}
		}

		if (hasDataChanged) {
			// If the data has changed, update both the UI and the ActiveSet component.
			const slotsMutator = this.activeSetPayload.mutators.activeSet.slots

			for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
				const newState = desiredState[i]
				const newItemId = newState?.itemId || null

				this.hotbar.setSlotContent(i, {
					itemId: newItemId,
					iconAsset: newState?.iconAsset || null,
				})
				// Use the fast mutator to update the payload data directly.
				slotsMutator[i] = newItemId || 0
			}

			this.commands.setComponentData(this.playerId, this.activeSetPayload.payload)
			this.cachedSlotEntityIds = [...desiredSlotEntityIds]
		}

		// --- Active Slot Highlight Sync ---
		let newActiveSlot = 0
		for (const chunk of this.playerUpdateQuery.iter()) {
			// Because the query is reactive, we only check entities that have changed.
			if (this.playerUpdateQuery.hasChanged(chunk, 0)) {
				const playerActiveSetArrays = chunk.componentArrays[this.activeSet]
				newActiveSlot = playerActiveSetArrays.activeSlotIndex[0]

				if (newActiveSlot !== this.cachedActiveSlot) {
					this.hotbar.swapSlot(newActiveSlot)
					this.cachedActiveSlot = newActiveSlot
				}
			}
		}

		this._syncCooldownVisuals(desiredState)
	}

	_syncCooldownVisuals(desiredState) {
		for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
			const itemInfo = desiredState[i]
			if (itemInfo) {
				const remainingTime = this.cooldownManager.getRemaining(this.playerId, itemInfo.prefabId)
				if (remainingTime > 0) {
					this.hotbar.updateCooldown(i, { remainingTime, totalDuration: itemInfo.totalDuration })
				} else {
					this.hotbar.updateCooldown(i, null)
				}
			} else {
				this.hotbar.updateCooldown(i, null)
			}
		}
	}
}
