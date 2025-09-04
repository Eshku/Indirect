const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { uiManager, queryManager, componentManager, cooldownManager } =
	theManager.getManagers()

const { PlayerTag, PrefabId, Owner, InActiveSet, Icon, Cooldown, ActiveSet } = await componentManager.getComponents()
const { HOTBAR_SLOT_COUNT } = await import(`${PATH_UI}/Hotbar.js`)

/**
 * Synchronizes the state of the player's hotbar with the Hotbar UI.
 */
export class HotbarSyncSystem {
	constructor() {
		this.hotbarItemsQuery = queryManager.getQuery({
			with: [Owner, InActiveSet, PrefabId, Icon, Cooldown],
		})
		// This query is for reacting to active slot changes in the update loop.
		this.playerUpdateQuery = queryManager.getQuery({
			// This query is now reactive. It will only process when the player's ActiveSet changes.
			with: [PlayerTag, ActiveSet],
			react: [ActiveSet],
		})
		// This query is for finding the player entity at startup.
		this.playerInitQuery = queryManager.getQuery({ with: [PlayerTag] })

		this.ownerTypeID = componentManager.getComponentTypeID(Owner)
		this.inActiveSetTypeID = componentManager.getComponentTypeID(InActiveSet)
		this.prefabIdTypeID = componentManager.getComponentTypeID(PrefabId)
		this.iconTypeID = componentManager.getComponentTypeID(Icon)
		this.cooldownTypeID = componentManager.getComponentTypeID(Cooldown)
		this.activeSetTypeID = componentManager.getComponentTypeID(ActiveSet)
		this.stringStorage = componentManager.stringManager.storage
		this.cooldownManager = cooldownManager

		this.playerId = null
		this.cachedSlotEntityIds = Array(HOTBAR_SLOT_COUNT).fill(0)
		this.cachedActiveSlot = -1
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
			const ownerArrays = chunk.componentArrays[this.ownerTypeID]
			const inActiveSetArrays = chunk.componentArrays[this.inActiveSetTypeID]
			const prefabIdArrays = chunk.componentArrays[this.prefabIdTypeID]
			const iconArrays = chunk.componentArrays[this.iconTypeID]
			const cooldownArrays = chunk.componentArrays[this.cooldownTypeID]

			const ownerEntityIds = ownerArrays.entityId
			const slots = inActiveSetArrays.slot
			const durations = cooldownArrays.duration

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (ownerEntityIds[indexInChunk] !== this.playerId) {
					continue
				}

				const entityId = chunk.entities[indexInChunk]
				const slot = slots[indexInChunk]

				if (slot < HOTBAR_SLOT_COUNT) {
					const prefabIdRef = prefabIdArrays.id[indexInChunk]
					const prefabIdStr = stringStorage[prefabIdRef]
					const iconAssetStr = stringStorage[iconArrays.assetName[indexInChunk]]
					desiredState[slot] = {
						itemId: entityId,
						prefabIdRef: prefabIdRef,
						prefabId: prefabIdStr,
						iconAsset: iconAssetStr,
						totalDuration: durations[indexInChunk],
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
			const slotUpdateData = {}
			for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
				const newState = desiredState[i]
				const newItemId = newState?.itemId || null

				this.hotbar.setSlotContent(i, {
					itemId: newItemId,
					iconAsset: newState?.iconAsset || null,
				})

				slotUpdateData[`slots${i}`] = newItemId || 0
			}

			this.commands.setComponentData(this.playerId, this.activeSetTypeID, slotUpdateData)
			this.cachedSlotEntityIds = [...desiredSlotEntityIds]
		}

		// --- Active Slot Highlight Sync ---
		let newActiveSlot = 0
		for (const chunk of this.playerUpdateQuery.iter()) {
			// Because the query is reactive, we only check entities that have changed.
			if (this.playerUpdateQuery.hasChanged(chunk, 0)) {
				const playerActiveSetArrays = chunk.componentArrays[this.activeSetTypeID]
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
				const remainingTime = this.cooldownManager.getRemaining(this.playerId, itemInfo.prefabIdRef)
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