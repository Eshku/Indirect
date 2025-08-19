const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { entityManager, prefabManager, componentManager } = theManager.getManagers()
const { Strength, Dexterity, Intelligence } = componentManager.getComponents()
const { DamageCalculationService } = await import('./DamageCalculationService.js')
const { LRUCache } = await import(`${PATH_CORE}/DataStructures/LRUCache.js`)

/**
 * A stateless service that resolves data descriptors from tooltips into displayable values.
 * It encapsulates the complex logic of fetching data from various sources (owner, item, children)
 * and applying transformations.
 */
export class TooltipResolutionService {
	constructor() {
		this.entityManager = entityManager
		this.prefabManager = prefabManager
		this.damageCalculator = new DamageCalculationService()

		// Cache for flattened maps of keyed child nodes from prefabs to avoid recursive searches.
		this.prefabChildNodeMapCache = new LRUCache(50)
		// In a real scenario, we'd have a more dynamic way to get all stat components.
		this.statComponentClasses = [Strength, Dexterity, Intelligence]
	}

	/**
	 * Builds or retrieves from cache a flattened map of all keyed child nodes within a prefab.
	 * This turns a recursive O(N) search into a one-time O(N) build and subsequent O(1) lookups.
	 * @param {string} prefabId - The unique ID of the prefab, used as the cache key.
	 * @param {object[]} children - The array of child entity definitions from the prefab.
	 * @returns {Map<string, object>} A map of node keys to their data objects.
	 */
	getOrBuildChildNodeMap(prefabId, children) {
		if (!prefabId) return new Map() // Should not happen for valid prefabs

		const cachedMap = this.prefabChildNodeMapCache.get(prefabId)
		if (cachedMap) {
			return cachedMap
		}

		const nodeMap = new Map()
		const flatten = childList => {
			if (!childList) return
			for (const child of childList) {
				if (child.key) {
					nodeMap.set(child.key, child)
				}
				if (child.children?.length > 0) {
					flatten(child.children)
				}
			}
		}

		flatten(children)

		this.prefabChildNodeMapCache.set(prefabId, nodeMap)
		return nodeMap
	}

	/**
	 * Gathers all relevant stat values for an entity (typically the item's owner).
	 * @param {number | null} ownerId - The entity ID of the owner.
	 * @returns {object} An object mapping stat names (e.g., 'Intelligence') to their values.
	 */
	getOwnerStats(ownerId) {
		const stats = {}
		if (ownerId === null || !this.entityManager.isEntityActive(ownerId)) return stats
		for (const StatClass of this.statComponentClasses) {
			const statComp = this.entityManager.getComponent(ownerId, StatClass)
			if (statComp) {
				// The stat name is derived directly from the component's class name.
				const pascalCaseStatName = StatClass.name // e.g., 'Intelligence'
				stats[pascalCaseStatName] = statComp.value
			}
		}
		return stats
	}

	/**
	 * Resolves a descriptor object into a final value, fetching data and applying transforms as needed.
	 * @param {object} descriptor - The descriptor object from the tooltip template.
	 * @param {object} context - The context for resolution, containing { itemPrefabData, childNodeMap, ownerStats, itemDisplayName }.
	 * @returns {{value: string, [key: string]: any}} The resolved value and any other relevant data (e.g., damageType).
	 */
	resolveValue(descriptor, context) {
		const { itemPrefabData, childNodeMap, ownerStats, itemDisplayName } = context

		if (!descriptor || !descriptor.from) {
			return { value: 'INVALID_DESCRIPTOR' }
		}

		const { from, transform } = descriptor
		const { source, childKey, path } = from

		let sourceData
		if (source === 'child') {
			if (!childKey) {
				console.warn(`TooltipResolutionService: 'childKey' is missing for 'child' source in descriptor for '${itemDisplayName}'.`)
				return { value: 'INVALID_KEY' }
			}
			sourceData = childNodeMap.get(childKey)
			if (!sourceData) {
				console.warn(`TooltipResolutionService: Stat value for '${itemDisplayName}' references non-existent child node key '${childKey}'.`)
				return { value: 'INVALID_KEY' }
			}
		} else if (source === 'self') {
			sourceData = itemPrefabData
		} else {
			console.warn(`TooltipResolutionService: Unknown source type '${source}' for '${itemDisplayName}'.`)
			return { value: 'INVALID_SOURCE' }
		}

		const getObjectByPath = (obj, p) => p.split('.').reduce((o, i) => o?.[i], obj)

		let value = getObjectByPath(sourceData, path)

		// Special case for projectile "hopping"
		if (value === undefined && source === 'child') {
			const spawnComp = sourceData.components?.spawnProjectile
			if (spawnComp?.projectilePrefab) {
				const projectilePrefabId = String(spawnComp.projectilePrefab)
				const projectileData = this.prefabManager.getPrefabDataSync(projectilePrefabId)
				if (projectileData) {
					value = getObjectByPath(projectileData, path)
				}
			}
		}

		if (value === undefined) {
			console.warn(`TooltipResolutionService: Could not resolve path '${path}' for '${itemDisplayName}'.`)
			return { value: 'INVALID_PATH' }
		}

		// Now apply transform if it exists
		if (transform) {
			if (transform === 'calculateDamage') {
				const damage = this.damageCalculator.calculate({ components: { dealDamage: value } }, ownerStats)
				return { value: `${damage.finalValue}`, damageType: value.damageType }
			} else if (transform === 'generateScalingFormula') {
				if (!value.scaling || value.scaling.length === 0) return { value: '' }
				const baseValue = value.baseValue || 0
				const formulaParts = [String(baseValue)]
				for (const scale of value.scaling) {
					const statAbbr = scale.stat.substring(0, 3).toUpperCase()
					const multiplierPercent = scale.multiplier * 100
					const displayPercent = Number.isInteger(multiplierPercent) ? multiplierPercent : multiplierPercent.toFixed(0)
					formulaParts.push(`+ ${displayPercent}% ${statAbbr}`)
				}
				return { value: `${formulaParts.join(' ')}` }
			} else {
				console.warn(`TooltipResolutionService: Unknown transform '${transform}' for '${itemDisplayName}'.`)
			}
		}

		return { value: String(value) }
	}
}