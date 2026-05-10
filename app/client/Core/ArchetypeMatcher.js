import { entityStore, MASK_PARTS } from '@managers/EntityManager/EntityManager.js'

//! would need to move data from entity manager too later on, once we attempt to allow workers to use masking.
//! gonna figure out how to reorg data.

/**
 * A stateless utility to check if an archetype matches a set of component mask rules.
 * This is a core engine primitive used by both the QueryManager and EntityMaskManager.
 *
 * @param {number} archetypeId The ID of the archetype to check.
 * @param {object} rule The rule object.
 * @param {BigUint64Array} [rule.with] A bitmask of components that MUST be present.
 * @param {BigUint64Array} [rule.without] A bitmask of components that must NOT be present.
 * @param {BigUint64Array} [rule.any] A bitmask where at least one component must be present.
 * @returns {boolean} True if the archetype matches the rule.
 */
export function archetypeMatches(archetypeId, { with: withMask, without: withoutMask, any: anyMask }) {
	const archetypeMaskOffset = archetypeId * MASK_PARTS

	// Check required components
	if (withMask) {
		for (let i = 0; i < MASK_PARTS; i++) {
			const part = entityStore.archetypeMasks[archetypeMaskOffset + i]
			if ((part & withMask[i]) !== withMask[i]) {
				return false
			}
		}
	}

	// Check excluded components
	if (withoutMask) {
		for (let i = 0; i < MASK_PARTS; i++) {
			const part = entityStore.archetypeMasks[archetypeMaskOffset + i]
			if ((part & withoutMask[i]) !== 0n) {
				return false
			}
		}
	}

	// Check anyOf components
	if (anyMask) {
		let hasAnyRequirement = false
		for (let i = 0; i < MASK_PARTS; i++) {
			if (anyMask[i] > 0n) {
				hasAnyRequirement = true
				break
			}
		}

		if (hasAnyRequirement) {
			let hasAnyMatch = false
			for (let i = 0; i < MASK_PARTS; i++) {
				const part = entityStore.archetypeMasks[archetypeMaskOffset + i]
				if ((part & anyMask[i]) !== 0n) {
					hasAnyMatch = true
					break
				}
			}
			if (!hasAnyMatch) {
				return false
			}
		}
	}

	return true
}