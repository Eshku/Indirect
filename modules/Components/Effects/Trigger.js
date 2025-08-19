/**
 * A "hot" component that defines when an effect entity should be processed.
 *
 * @note **Design Choice: `enum` vs. `bitmask`**
 * This component uses the `enum` schema type because its `on` property represents
 * a set of **mutually exclusive** states. An effect is triggered `OnUse` OR `OnHit`,
 * but never both at the same time.
 *
 * This contrasts with a component like `PhysicsState`, which uses a `bitmask` because
 * an entity can be in multiple states simultaneously (e.g., `AIRBORNE` and `STUNNED`).
 */


export class Trigger {
	static schema = {
		on: {
			type: 'enum',
			of: 'u8',
			values: ['OnUse', 'OnHit', 'OnExpiration', 'OnCast'],
		},
	}

	constructor({ on = 0 } = {}) {
		this.on = on
	}
}