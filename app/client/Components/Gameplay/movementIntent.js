/**
 * A component that stores an entity's desired movement direction as a normalized vector.
 *
 * @note **Design Choice: Normalized Vector**
 * `desiredX` and `desiredY` properties are intended to store a **normalized 2D vector**.
 * This means vector `(desiredX, desiredY)` should have a length of 1 (or 0 if not moving).
 *
 * For example:
 * - Moving right: `{ desiredX: 1, desiredY: 0 }`
 * - Moving diagonally up-left: `{ desiredX: -0.707, desiredY: 0.707 }`
 *
 * Responsibility for normalizing this vector lies with the system that sets the intent
 * (e.g., an `InputSystem` for player, or an `AISystem` for NPCs).
 *
 */
export const movementIntent = {
	/**
	 * Desired x-component of movement vector (normalized).
	 */
	desiredX: {
		type: 'f32',
		default: 0,
	},
	/**
	 * Desired y-component of movement vector (normalized).
	 */
	desiredY: {
		type: 'f32',
		default: 0,
	},
}
