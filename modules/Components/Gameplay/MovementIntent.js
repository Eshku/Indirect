/**
 * A "hot" component that stores an entity's desired movement direction.
 *
 * @note **Design Choice: Normalized Vector**
 * The `desiredX` and `desiredY` properties are intended to store a **normalized 2D vector**.
 * This means the vector `(desiredX, desiredY)` should have a length of 1 (or 0 if not moving).
 *
 * For example:
 * - Moving right: `{ desiredX: 1, desiredY: 0 }`
 * - Moving diagonally up-left: `{ desiredX: -0.707, desiredY: 0.707 }`
 *
 * The responsibility for normalizing this vector lies with the system that sets the intent
 * (e.g., an `InputSystem` for the player, or an `AISystem` for NPCs).
 *
 * This design makes the `MovementSystem` extremely efficient, as it can simply multiply
 * this normalized vector by a `Speed` component without needing to perform costly
 * normalization calculations for every moving entity, every frame.
 */
export class MovementIntent {
	static schema = {
		desiredX: 'f32',
		desiredY: 'f32',
	}
	constructor({ desiredX = 0, desiredY = 0 } = {}) {
		this.desiredX = desiredX
		this.desiredY = desiredY
	}
}
