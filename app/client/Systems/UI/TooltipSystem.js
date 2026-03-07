const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs, uiManager } = engine.getManagers()
const { ItemTooltip } = await import(`${PATH_UI}/ItemTooltip.js`)

const { entityStore } = await import(`${PATH_MANAGERS}/EntityManager/EntityManager.js`)

const { stringInterningTable } = await import(`${PATH_INDIRECT}/StringInterningTable.js`)

const { Easing } = await import(`${PATH_CORE}/utils/easing.js`)
const { lerp } = await import(`${PATH_CORE}/utils/lerp.js`)

const { LRUCache } = await import(`${PATH_CORE}/DataStructures/LRUCache.js`)

//!Legacy

// --- Constants for tooltip behavior ---
const LINGER_DURATION_MS = 200
const FADE_OUT_DURATION_MS = 500
const LERP_SPEED = 25

// --- RPN (Reverse Polish Notation) Constants for stat calculation ---
const RPN_OP = {
	PUSH_LITERAL: -1,
	PUSH_BASE: -2,
	PUSH_STAT: -3,
	ADD: -4,
	SUBTRACT: -5,
	MULTIPLY: -6,
	DIVIDE: -7,
}

const STAT_INDEX_TO_NAME = ['Strength', 'Dexterity', 'Intelligence', 'Vitality']

/**
 * Manages the entire lifecycle and rendering of tooltips.
 */
export class TooltipSystem {
	constructor() {
		this.state = 'HIDDEN'
		this.stateChangeTimestamp = 0
		this.targetEntityId = null

		this.activeTooltipView = null
		this.lastShownTargetId = null
		this.currentPosition = { x: 0, y: 0 }
		this.targetPosition = { x: 0, y: 0 }
		this.hotbar = null

		const { tooltip, parent, displayName, damage, cooldown, range, strength, dexterity, intelligence } =
			ecs.getTypeIDs()

		Object.assign(this, { tooltip, parent, displayName, damage, cooldown, range })

		this.statComponentTypeIds = new Map()
		this.statComponentTypeIds.set('Strength', strength)
		this.statComponentTypeIds.set('Dexterity', dexterity)
		this.statComponentTypeIds.set('Intelligence', intelligence)

		this.stringStorage = stringInterningTable.storage
		this.viewModelCache = new LRUCache(50)
		this.statComponentNames = ['Strength', 'Dexterity', 'Intelligence']
	}

	async init() {
		const { gameManager, layerManager } = engine.getManagers()
		const pixiApp = await gameManager.getApp()

		// Create and register the tooltip view this system manages.
		this.tooltipView = new ItemTooltip(pixiApp, layerManager.getLayer('ui'))
		uiManager.register(this.tooltipView, 'ItemTooltip')

		// The Hotbar might not exist if its system is disabled.
		this.hotbar = uiManager.getElement('Hotbar')
		if (this.hotbar) {
			this.setupHotbarEvents()
		}
	}

	setupHotbarEvents() {
		// Bind the event handlers to `this` instance so they can be removed correctly in destroy().
		this.onHotbarPointerMove = this.onHotbarPointerMove.bind(this)
		this.onHotbarPointerLeave = this.onHotbarPointerLeave.bind(this)

		this.hotbar.container.on('pointermove', this.onHotbarPointerMove)
		this.hotbar.container.on('pointerleave', this.onHotbarPointerLeave)
	}

	onHotbarPointerMove(event) {
		const pos = event.data.global
		const slotIndex = this.hotbar.getSlotIndexAt(pos)
		const newTargetId =
			slotIndex !== null && this.hotbar.slots[slotIndex].itemId ? this.hotbar.slots[slotIndex].itemId : null

		if (newTargetId) {
			this.show(newTargetId, pos.x, pos.y)
		} else {
			this.startLinger()
		}
	}

	onHotbarPointerLeave() {
		this.startLinger()
	}

	show(entityId, x, y) {
		const wasHidden = this.state === 'HIDDEN'
		this.state = 'SHOWN'
		this.targetEntityId = entityId
		this.targetPosition.x = x
		this.targetPosition.y = y

		if (wasHidden) {
			this.currentPosition.x = x
			this.currentPosition.y = y
		}

		if (!this.activeTooltipView || this.lastShownTargetId !== entityId) {
			const viewModel = this.buildViewModel(entityId)
			if (!viewModel) {
				this.hide()
				return
			}

			const tooltipView = this.activeTooltipView || uiManager.getElement('ItemTooltip')
			if (!tooltipView) {
				console.error(`TooltipSystem: Tooltip view "${viewModel.type}" is not registered with the UIManager.`)
				this.hide()
				return
			}

			tooltipView.update(viewModel)
			tooltipView.show()
			this.activeTooltipView = tooltipView
			this.lastShownTargetId = entityId
		}

		this.activeTooltipView.setAlpha(1)
	}

	startLinger() {
		if (this.state === 'SHOWN') {
			this.state = 'LINGERING'
			this.stateChangeTimestamp = performance.now()
		}
	}

	hide() {
		if (this.activeTooltipView) {
			this.activeTooltipView.hide()
		}
		this.state = 'HIDDEN'
		this.activeTooltipView = null
		this.lastShownTargetId = null
		this.targetEntityId = null
	}

	update(deltaTime) {
		const now = performance.now()

		if (this.state === 'LINGERING') {
			if (now - this.stateChangeTimestamp >= LINGER_DURATION_MS) {
				this.state = 'FADING_OUT'
				this.stateChangeTimestamp = now
			}
		} else if (this.state === 'FADING_OUT') {
			const elapsed = now - this.stateChangeTimestamp
			const linearProgress = Math.min(1, elapsed / FADE_OUT_DURATION_MS)
			const easedProgress = Easing.easeOutCubic(linearProgress)

			if (this.activeTooltipView) {
				this.activeTooltipView.setAlpha(1 - easedProgress)
			}

			if (linearProgress >= 1) {
				this.hide()
			}
		}

		if (this.activeTooltipView && this.state !== 'HIDDEN') {
			const lerpFactor = 1 - Math.exp(-LERP_SPEED * deltaTime)
			this.currentPosition.x = lerp(this.currentPosition.x, this.targetPosition.x, lerpFactor)
			this.currentPosition.y = lerp(this.currentPosition.y, this.targetPosition.y, lerpFactor)
			this.activeTooltipView.setPosition(this.currentPosition.x, this.currentPosition.y)
		}
	}

	buildViewModel(itemEntityId) {
		const cachedResult = this.viewModelCache.get(itemEntityId)
		if (cachedResult) {
			return cachedResult
		}

		if (!ecs.entityManager.isEntityActive(itemEntityId)) return null

		const archetypeId = ecs.entityManager.getArchetypeForEntity(itemEntityId)
		if (archetypeId === null) return null

		const location = ecs.entityManager.getEntityLocation(itemEntityId)
		if (!location) return null

		const { chunkId, indexInChunk } = location

		const tooltipArrays = entityStore.chunkComponentData[chunkId][this.tooltip]
		if (!tooltipArrays) return null

		const type = this.stringStorage[tooltipArrays.type[indexInChunk]]
		const description = this.stringStorage[tooltipArrays.description[indexInChunk]]

		let ownerId = null
		const parentArrays = entityStore.chunkComponentData[chunkId][this.parent]
		if (parentArrays) {
			ownerId = parentArrays.entityId[indexInChunk]
		}

		const ownerStats = this.getOwnerStats(ownerId)

		const displayNameArrays = entityStore.chunkComponentData[chunkId][this.displayName]
		const titleRef = displayNameArrays?.value[indexInChunk]
		const title = titleRef ? this.stringStorage[titleRef] : 'Unknown Item'

		const viewModel = {
			type,
			title,
			description: [{ type: 'text', value: description }],
			stats: [],
		}

		const resolutionContext = {
			chunkId,
			indexInChunk,
			ownerStats,
		}

		const statsLength = tooltipArrays.stats_count[indexInChunk]

		for (let i = 0; i < statsLength; i++) {
			// Access the flattened array property directly.
			const statRef = tooltipArrays[`stats${i}`]?.[indexInChunk]
			const statName = this.stringStorage[statRef]
			const resolvedStat = this.resolveStat(statName, resolutionContext)

			if (resolvedStat) {
				viewModel.stats.push(resolvedStat)
			}
		}

		this.viewModelCache.set(itemEntityId, viewModel)
		return viewModel
	}

	calculateDamage(damageArrays, indexInChunk, ownerStats) {
		let totalDamage = 0
		const numDamageEntries = damageArrays.baseValues_count[indexInChunk]

		const rpnStreamForEntity = []
		const streamLength = damageArrays.formulas_rpnStream_count?.[indexInChunk] ?? 0

		for (let i = 0; i < streamLength; i++) {
			rpnStreamForEntity.push(damageArrays[`formulas_rpnStream${i}`]?.[indexInChunk])
		}

		for (let i = 0; i < numDamageEntries; i++) {
			const baseValue = damageArrays[`baseValues${i}`]?.[indexInChunk]

			const formulaStartIndex = damageArrays[`formulas_formulaStarts${i}`]?.[indexInChunk] ?? -1
			const formulaLength = damageArrays[`formulas_formulaLengths${i}`]?.[indexInChunk] ?? 0

			if (formulaStartIndex !== -1 && formulaLength > 0 && rpnStreamForEntity.length > 0) {
				const rpnSubArray = rpnStreamForEntity.slice(formulaStartIndex, formulaStartIndex + formulaLength)
				totalDamage += this.evaluateRPN(rpnSubArray, baseValue, ownerStats)
			} else {
				totalDamage += baseValue
			}
		}

		return totalDamage
	}

	evaluateRPN(rpnStream, baseValue, ownerStats) {
		const stack = []
		for (let i = 0; i < rpnStream.length; i++) {
			const op = rpnStream[i]
			switch (op) {
				case RPN_OP.PUSH_LITERAL:
					stack.push(rpnStream[++i])
					break
				case RPN_OP.PUSH_BASE:
					stack.push(baseValue)
					break
				case RPN_OP.PUSH_STAT: {
					const statIndex = rpnStream[++i]
					const statName = STAT_INDEX_TO_NAME[statIndex]
					stack.push(ownerStats[statName] || 0)
					break
				}
				case RPN_OP.ADD:
					stack.push(stack.pop() + stack.pop())
					break
				case RPN_OP.SUBTRACT: {
					const b = stack.pop(),
						a = stack.pop()
					stack.push(a - b)
					break
				}
				case RPN_OP.MULTIPLY:
					stack.push(stack.pop() * stack.pop())
					break
				case RPN_OP.DIVIDE: {
					const b = stack.pop(),
						a = stack.pop()
					stack.push(b !== 0 ? a / b : 0)
					break
				}
				default:
					console.error(`RPN evaluation: Unknown opcode ${op}`)
					return 0
			}
		}
		return stack.pop() || 0
	}

	getOwnerStats(ownerId) {
		const stats = {}
		if (ownerId === null || !ecs.entityManager.isEntityActive(ownerId)) {
			return stats
		}

		const ownerArchetypeId = ecs.entityManager.getArchetypeForEntity(ownerId)
		if (ownerArchetypeId === null) return stats

		const location = ecs.entityManager.getEntityLocation(ownerId)
		if (!location) return stats

		const { chunkId, indexInChunk } = location

		for (const statName of this.statComponentNames) {
			const statTypeId = this.statComponentTypeIds.get(statName)
			const statArrays = statTypeId !== undefined ? entityStore.chunkComponentData[chunkId][statTypeId] : undefined

			if (statArrays) {
				stats[statName] = statArrays.value[indexInChunk]
			}
		}
		return stats
	}

	resolveStat(statName, context) {
		const { chunkId, indexInChunk } = context

		switch (statName) {
			case 'Damage': {
				const damageArrays = entityStore.chunkComponentData[chunkId][this.damage]
				if (!damageArrays) return null
				const totalDamage = this.calculateDamage(damageArrays, indexInChunk, context.ownerStats)
				return { label: 'Damage', value: `${Math.round(totalDamage)}` }
			}
			case 'Cooldown': {
				const cooldownArrays = entityStore.chunkComponentData[chunkId][this.cooldown]
				if (!cooldownArrays) return null

				const sharedGroupId = cooldownArrays.sharedGroupId?.[indexInChunk]
				if (sharedGroupId === undefined) return null
				//! prop groups were removed, going to be replaced with thread-safe prototypes later on or whatever I make to replace the thing.
				const sharedGroup = this.propertyGroupManager.sharedGroups[sharedGroupId] 
				
				const duration = sharedGroup?.[this.cooldown]?.duration ?? 0
				return { label: 'Cooldown', value: `${duration.toFixed(2)}s` }
			}
			case 'Range': {
				const rangeArrays = entityStore.chunkComponentData[chunkId][this.range]
				if (!rangeArrays) return null

				const value = rangeArrays.value[indexInChunk]
				return { label: 'Range', value: `${value}` }
			}
			default:
				console.warn(`TooltipSystem: Unknown stat type "${statName}" requested.`)
				return null
		}
	}

	destroy() {
		if (this.hotbar) {
			this.hotbar.container.off('pointermove', this.onHotbarPointerMove)
			this.hotbar.container.off('pointerleave', this.onHotbarPointerLeave)
		}
		if (this.tooltipView) {
			uiManager.unregister(this.tooltipView)
			this.tooltipView.destroy()
			this.tooltipView = null
		}
	}
}
