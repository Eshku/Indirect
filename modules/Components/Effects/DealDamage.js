/**
 * @fileoverview Defines the DealDamage component, which represents a single instance of damage to be applied.
 *
 *
 * ### Developer Note: Performance in Critical Systems
 *
 * Damage calculation is a performance-critical path, often occurring in large bursts (e.g., when an
 * Area-of-Effect spell hits many targets). In these "burst" scenarios, we cannot rely on the JIT
 * compiler to have already optimized the code. The initial, unoptimized execution speed is what matters.
 *
 * To ensure maximum performance from the very first frame, avoid accessing the static enum helper
 * (`DealDamage.DAMAGETYPE.Fire`) directly inside a tight, per-entity loop. While the JIT will
 * eventually optimize this away, the initial property lookups have a small but real cost that
 * accumulates over thousands of entities.
 *
 * **The correct, high-performance pattern is to "hoist" the enum value out of the loop.**
 *
 * #### Recommended System Implementation:
 *
 * ```javascript
 * // Inside a hypothetical DamageSystem
 *
 * // In constructor or update method, before the loops:
 * const FIRE_DAMAGE_TYPE = DealDamage.DAMAGETYPE.Fire;
 *
 * for (const chunk of this.query.iter()) {
 *     const damageArrays = chunk.archetype.componentArrays[this.dealDamageTypeID];
 *
 *     for (const entityIndex of chunk) {
 *         // This comparison is now between a value from a TypedArray and a local
 *         // variable. It is as fast as possible and has no JIT dependency.
 *         if (damageArrays.damageType[entityIndex] === FIRE_DAMAGE_TYPE) {
 *             // ... apply fire logic ...
 *         }
 *     }
 * }
 * ```
 *
 * This pattern provides the best of both worlds: the code remains highly readable by using the
 * enum helper, while the critical inner loop achieves guaranteed, raw performance.
 */
export class DealDamage {
	static schema = {
		damageType: {
			type: 'enum',
			of: 'u8',
			values: ['Physical', 'Fire', 'Ice', 'Lightning', 'Poison'],
		},
		baseValue: 'f32',
	}

	constructor({ damageType = 0, baseValue = 0 } = {}) {
		this.damageType = damageType
		this.baseValue = baseValue
	}
}
