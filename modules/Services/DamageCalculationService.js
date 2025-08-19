/**
 * @fileoverview A service for calculating damage based on component data and entity stats.
 */
export class DamageCalculationService {
	/**
	 * Calculates the final damage value from a dealDamage component and owner stats.
	 * @param {object} node - The prefab node containing the dealDamage component.
	 * @param {object} [ownerStats={}] - A map of the owner's stats, e.g., { Strength: 10, Intelligence: 5 }.
	 * @returns {{finalValue: number, formula: string}} The calculated damage and a descriptive formula.
	 */
	calculate(node, ownerStats = {}) {
		const dealDamage = node.components?.dealDamage
		if (!dealDamage) {
			return { finalValue: 0, baseValue: 0, bonusDamage: 0 }
		}

		const baseValue = dealDamage.baseValue || 0
		let bonusDamage = 0

		if (dealDamage.scaling) {
			for (const scale of dealDamage.scaling) {
				// Stat names in prefabs are PascalCase, e.g., "Intelligence"
				const statValue = ownerStats[scale.stat] || 0

				if (scale.type === 'Additive') {
					bonusDamage += statValue * scale.multiplier
				}
				// Future: Add other scaling types like 'Multiplicative' here.
			}
		}

		const finalValue = baseValue + bonusDamage
		return {
			finalValue: Math.round(finalValue),
			baseValue: baseValue,
			bonusDamage: Math.round(bonusDamage),
		}
	}
}