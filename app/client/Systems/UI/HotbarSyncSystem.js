const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs, uiManager } = engine.getManagers()
const { queryManager, sharedDataManager } = ecs
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

const { stringInterningTable } = await import(`${PATH_INDIRECT}/StringInterningTable.js`)

const { Hotbar, HOTBAR_SLOT_COUNT } = await import(`${PATH_UI}/Hotbar.js`)

/**
 * Synchronizes the state of the player's hotbar with the Hotbar UI.
 */
export class HotbarSyncSystem {
	constructor() {
		const { owner, inActiveSet, prefab, icon, cooldown, playerTag, activeSet, activeCooldown } = ecs.getTypeIDs()
		Object.assign(this, { owner, inActiveSet, prefab, icon, cooldown, playerTag, activeSet, activeCooldown })

		this.hotbarItemsQuery = queryManager.getQuery({
			with: [owner, inActiveSet, prefab, icon, cooldown],
		})

		this.playerUpdateQuery = queryManager.getQuery({
			with: [playerTag, activeSet],
			react: [activeSet],
		})

		// This query is now REACTIVE. It will only iterate over cooldowns that
		// have been created, destroyed, or had their remainingTime changed.
		this.cooldownsQuery = queryManager.getQuery({
			with: [this.activeCooldown],
			react: [this.activeCooldown],
		})

		// Find player entity at startup.
		this.playerInitQuery = queryManager.getQuery({ with: [playerTag] })

		this.stringStorage = stringInterningTable.storage
		this.prefabManager = ecs.prefabManager
		this.playerId = null
		this.cachedSlotEntityIds = Array(HOTBAR_SLOT_COUNT).fill(0)
		this.cachedActiveSlot = -1

		// Pre-compile payload for ActiveSet component updates.
		this.activeSetPayload = payloadCompiler.compileComponent(this.activeSet, { slots: [] })

		// Use the new, unified shared data manager.
		this.sharedDataManager = sharedDataManager

		this.playerCooldowns = new Map() // Map<prefabId, remainingTime>
		this.hotbar = null
	}

	async init() {
		const { gameManager, layerManager } = engine.getManagers()
		const pixiApp = await gameManager.getApp()

		this.hotbar = new Hotbar(pixiApp, layerManager.getLayer('ui'))
		uiManager.register(this.hotbar)

		for (const chunk of this.playerInitQuery.iter()) {
			this.playerId = chunk.entities[0]
			break
		}
		if (!this.playerId) console.error('HotbarSyncSystem: Could not find player entity!')
		// Initial sync to render the hotbar correctly on first frame.
		this.update(0)
	}

	update({deltaTime}) {
		const desiredState = Array(HOTBAR_SLOT_COUNT).fill(null)
		const desiredSlotEntityIds = Array(HOTBAR_SLOT_COUNT).fill(0)
		const stringStorage = this.stringStorage

		for (const chunk of this.hotbarItemsQuery.iter()) {
			const ownerArrays = chunk.componentData[this.owner]
			const inActiveSetArrays = chunk.componentData[this.inActiveSet]
			const prefabIdArrays = chunk.componentData[this.prefab]
			const iconArrays = chunk.componentData[this.icon]

			const ownerEntityIds = ownerArrays.entityId
			const slots = inActiveSetArrays.slot

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (ownerEntityIds[indexInChunk] !== this.playerId) {
					continue
				}

				const entityId = chunk.entities[indexInChunk]
				const slot = slots[indexInChunk]

				if (slot < HOTBAR_SLOT_COUNT) {
					// --- NEW DATA ACCESS PATTERN ---
					// 1. Get the prototypeId from the entity's component data.
					const prototypeId = prefabIdArrays.prototypeId[indexInChunk]
					// 2. Get the prototype object from the prototypeStore.
					const prototype = this.sharedDataManager.prototypeStore[prototypeId]
					if (!prototype) continue

					// 3. Get the sharedDataIndex for each component from the prototype.
					const prefabDataIndex = prototype[this.prefab]
					const iconDataIndex = prototype[this.icon]
					const cooldownDataIndex = prototype[this.cooldown]

					// 4. Get the actual values from the valueStores or per-entity data.
					const prefabId = this.sharedDataManager.valueStores[this.prefab].id[prefabDataIndex]

					let iconAssetNameRef = iconArrays.assetName[indexInChunk]

					const iconAssetStr = stringStorage[iconAssetNameRef]

					let totalDuration = this.sharedDataManager.valueStores[this.cooldown].duration[cooldownDataIndex]

					desiredState[slot] = {
						itemId: entityId,
						prefabId: prefabId,
						iconAsset: iconAssetStr, // This is shared icon asset name
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
				slotsMutator[i] = newItemId || 0n
			}

			this.commands.setComponentData(this.playerId, this.activeSetPayload.payload)
			this.cachedSlotEntityIds = [...desiredSlotEntityIds]
		}

		// --- Active Slot Highlight Sync ---
		let newActiveSlot = 0

		for (const chunk of this.playerUpdateQuery.iter()) {
			// Because the query is reactive, we only check entities that have changed.
			if (chunk.hasChanged(this.activeSet, 0)) {
				// The player is a singleton, so we can check index 0.
				const playerActiveSetArrays = chunk.componentData[this.activeSet]
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
		// --- EFFICIENT REACTIVE UPDATE ---
		// This loop now only runs if cooldowns have changed, and only iterates
		// over the chunks containing those changed cooldowns.
		for (const chunk of this.cooldownsQuery.iter()) {
			const cooldowns = chunk.componentData[this.activeCooldown]
			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				// Check if this specific entity's cooldown component has changed.
				if (chunk.hasChanged(this.activeCooldown, indexInChunk)) {
					// We only care about cooldowns owned by our player.
					if (cooldowns.ownerId[indexInChunk] === this.playerId) {
						const prefabId = cooldowns.prefabId[indexInChunk]
						const remainingTime = cooldowns.remainingTime[indexInChunk]

						// Update or remove the entry in our persistent map.
						if (remainingTime > 0) this.playerCooldowns.set(prefabId, remainingTime)
						else this.playerCooldowns.delete(prefabId)
					}
				}
			}
		}

		for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
			const itemInfo = desiredState[i]
			if (itemInfo) {
				const remainingTime = this.playerCooldowns.get(Number(itemInfo.prefabId))
				if (remainingTime) {
					this.hotbar.updateCooldown(i, { remainingTime, totalDuration: itemInfo.totalDuration })
				} else {
					this.hotbar.updateCooldown(i, null)
				}
			} else {
				this.hotbar.updateCooldown(i, null)
			}
		}
	}

	destroy() {
		if (this.hotbar) {
			uiManager.unregister(this.hotbar)
			this.hotbar.destroy()
			this.hotbar = null
		}
	}
}
