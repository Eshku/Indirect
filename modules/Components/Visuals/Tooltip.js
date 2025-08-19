/**
 * Holds the data required to generate a UI tooltip for an entity.
 * This data is typically copied from a prefab upon entity creation and can be
 * modified at runtime for per-instance changes (e.g., item upgrades).
 */
export class Tooltip {
	constructor(type = 'ItemTooltip', title = '', description = [], stats = []) {
		this.type = type
		this.title = title
		this.description = description
		this.stats = stats
	}
}