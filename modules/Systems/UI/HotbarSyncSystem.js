const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { uiManager, queryManager, componentManager, entityManager, prefabManager } = theManager.getManagers()

const { PlayerTag, SharedCooldowns, PrefabId, Owner, InActiveSet, Icon, Cooldown, ActiveSet } =
	await componentManager.getComponents(
		'PlayerTag',
		'SharedCooldowns',
		'PrefabId',
		'Owner',
		'InActiveSet',
		'Icon',
		'Cooldown',
		'ActiveSet'
	)
const { HOTBAR_SLOT_COUNT } = await import(`${PATH_UI}/Hotbar.js`)

/**
 * Synchronizes the state of the player's hotbar with the Hotbar UI.
 * This system uses a relationship-based approach, querying for items that have
 * an `InActiveSet` component and are owned by the player.
 * This system is responsible for:
 * 1.  **Initial Population:** Telling the Hotbar UI which items to display in each slot at startup.
 * 2.  **Active Slot Highlight:** Updating the border of the active slot when it changes.
 * 3.  **Cooldown Visuals:** Updating cooldown animations every frame.
 * 4.  **Tooltip Events:** Triggering tooltip requests when hovering over slots.
 *
 */
export class HotbarSyncSystem {
	constructor() {
		// Query for all items that are currently on any hotbar.
		// We will filter this down to only the player's items.
		this.hotbarItemsQuery = queryManager.getQuery({
			with: [Owner, InActiveSet, PrefabId, Icon, Cooldown],
		})

		// Query for the player to get their shared cooldowns and active set state.
		this.playerCooldownsQuery = queryManager.getQuery({
			with: [PlayerTag, SharedCooldowns, ActiveSet],
		})
		// A simple query to find the player's entity ID once.
		this.playerQuery = queryManager.getQuery({ with: [PlayerTag] })

		// Store component type IDs for faster access.
		this.ownerTypeID = componentManager.getComponentTypeID(Owner)
		this.inActiveSetTypeID = componentManager.getComponentTypeID(InActiveSet)
		this.prefabIdTypeID = componentManager.getComponentTypeID(PrefabId)
		this.iconTypeID = componentManager.getComponentTypeID(Icon)
		this.cooldownTypeID = componentManager.getComponentTypeID(Cooldown)
		this.sharedCooldownsTypeID = componentManager.getComponentTypeID(SharedCooldowns)
		this.activeSetTypeID = componentManager.getComponentTypeID(ActiveSet)
		// For direct, high-performance access to string data from 'hot' components
		this.stringInterningTable = componentManager.stringInterningTable

		// --- System State Caches ---
		// The player's entity ID. We need this to filter items by owner.
		this.playerId = null

		// A simple cache of what's currently displayed in the UI.
		// We'll store the entity ID for each slot to detect changes.
		this.cachedSlotEntityIds = Array(HOTBAR_SLOT_COUNT).fill(0)
		this.cachedActiveSlot = -1

		/** @type {import('../../../UI/Hotbar.js').Hotbar | null} */
		this.hotbar = null
	}

	init() {
		this.hotbar = uiManager.getElement('Hotbar')

		// Find and cache the player's entity ID. This runs only once.
		for (const chunk of this.playerQuery.iter()) {
			for (const entityIndex of chunk) {
				this.playerId = chunk.archetype.entities[entityIndex]
				break
			}
			if (this.playerId) break
		}
		if (!this.playerId) console.error('HotbarSyncSystem: Could not find player entity!')

		// Run the update once on init to populate the hotbar immediately.
		this.update(0)
	}

	/**
	 * The main update loop for the system.
	 * @param {number} deltaTime - The time elapsed since the last frame.
	 */
	update(deltaTime) {
		if (!this.hotbar || !this.playerId) return

		// --- 1. Determine the desired state of the hotbar from the ECS ---
		const desiredState = Array(HOTBAR_SLOT_COUNT).fill(null)
		const desiredSlotEntityIds = Array(HOTBAR_SLOT_COUNT).fill(0)

		for (const chunk of this.hotbarItemsQuery.iter()) {
			const archetype = chunk.archetype
			const ownerArrays = archetype.componentArrays[this.ownerTypeID]
			const inActiveSetArrays = archetype.componentArrays[this.inActiveSetTypeID]
			const prefabIdArrays = archetype.componentArrays[this.prefabIdTypeID]
			const iconArrays = archetype.componentArrays[this.iconTypeID]
			const cooldownArrays = archetype.componentArrays[this.cooldownTypeID]

			// Hoist property access out of the loop for JIT optimization.
			const ownerEntityIds = ownerArrays.entityId
			const slots = inActiveSetArrays.slot


			const prefabIdOffsets = prefabIdArrays.id_offset
			const prefabIdLengths = prefabIdArrays.id_length
			const iconAssetOffsets = iconArrays.assetName_offset
			const iconAssetLengths = iconArrays.assetName_length
			const durations = cooldownArrays.duration

			for (const entityIndex of chunk) {
				// Filter by owner: only process items that belong to the player.
				if (ownerEntityIds[entityIndex] !== this.playerId) {
					continue
				}

				const entityId = archetype.entities[entityIndex]
				const slot = slots[entityIndex]

				if (slot < HOTBAR_SLOT_COUNT) {
					const prefabIdStr = this.stringInterningTable.get(prefabIdOffsets[entityIndex], prefabIdLengths[entityIndex])
					const iconAssetStr = this.stringInterningTable.get(iconAssetOffsets[entityIndex], iconAssetLengths[entityIndex])
					desiredState[slot] = {
						itemId: entityId,
						prefabId: prefabIdStr,
						iconAsset: iconAssetStr,
						totalDuration: durations[entityIndex],
					}
					desiredSlotEntityIds[slot] = entityId
				}
			}
		}

		// --- 2. Sync the UI by diffing desired state against cached state ---
		for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
			const newState = desiredState[i]
			const oldItemId = this.cachedSlotEntityIds[i]

			// If the item in the slot has changed...
			if (newState?.itemId !== oldItemId) {
				// No need to update the cache here, it's done after the command is issued.

				const iconAsset = newState?.iconAsset || null

				// Update the UI content (icon and tooltip data)
				this.hotbar.setSlotContent(i, {
					itemId: newState?.itemId || null,
					iconAsset,
				})
			}
		}

		// --- 3. Sync the player's ActiveSet component if it has changed ---
		let hasSlotChange = false
		for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
			if (this.cachedSlotEntityIds[i] !== desiredSlotEntityIds[i]) {
				hasSlotChange = true
				break
			}
		}

		if (hasSlotChange) {
			// Because ActiveSet.slots is a flattened array in a "hot" component,
			// we must provide the data as an object with keys `slots0`, `slots1`, etc.
			const slotUpdateData = {}
			for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
				slotUpdateData[`slots${i}`] = desiredSlotEntityIds[i]
			}

			this.commands.setComponentData(this.playerId, this.activeSetTypeID, slotUpdateData)
			// Update our cache to prevent re-sending the command next frame.
			this.cachedSlotEntityIds = [...desiredSlotEntityIds]
		}

		// --- 4. Sync the active slot highlight ---
		let newActiveSlot = -1
		let playerActiveSetArrays = null

		// This is a singleton query for the player.
		for (const chunk of this.playerCooldownsQuery.iter()) {
			playerActiveSetArrays = chunk.archetype.componentArrays[this.activeSetTypeID]
			for (const entityIndex of chunk) {
				// We only need the component array, not the entity data itself yet.
				newActiveSlot = playerActiveSetArrays.activeSlotIndex[entityIndex]
				break
			}
			if (playerActiveSetArrays) break
		}

		if (newActiveSlot !== this.cachedActiveSlot) {
			this.hotbar.deactivateSlot(this.cachedActiveSlot) // Safe to call with -1
			if (newActiveSlot !== -1) {
				this.hotbar.activateSlot(newActiveSlot)
			}
			this.cachedActiveSlot = newActiveSlot
		}

		// --- 5. Sync cooldowns every frame ---
		let sharedCooldowns = null
		for (const chunk of this.playerCooldownsQuery.iter()) {
			// This is a "cold" component, so we access the array of instances directly.
			const sharedCooldownsArr = chunk.archetype.componentArrays[this.sharedCooldownsTypeID]
			for (const entityIndex of chunk) {
				// This query should only find the single player entity.
				sharedCooldowns = sharedCooldownsArr[entityIndex]
				break
			}
			if (sharedCooldowns) break
		}

		if (sharedCooldowns) {
			this._syncCooldownVisuals(sharedCooldowns, desiredState)
		}
	}

	_syncCooldownVisuals(sharedCooldowns, desiredState) {
		// The key in the cooldowns map is the item's string prefabId.
		const cooldownsMap = sharedCooldowns.cooldowns
		for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
			const itemInfo = desiredState[i]
			if (itemInfo) {
				const remainingTime = cooldownsMap.get(itemInfo.prefabId)
				if (remainingTime !== undefined) {
					this.hotbar.updateCooldown(i, { remainingTime, totalDuration: itemInfo.totalDuration })
				} else {
					this.hotbar.updateCooldown(i, null)
				}
			} else {
				// Ensure empty slots have no cooldown visual
				this.hotbar.updateCooldown(i, null)
			}
		}
	}
}
