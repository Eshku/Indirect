/**
 * A "hot" component that tracks whether an entity is currently on the ground.
 * This is frequently checked by systems like Gravity and Jump.
 */
export class IsGrounded {
	static schema = {
		isGrounded: 'boolean',
	}

	constructor({ isGrounded = false } = {}) {
		this.isGrounded = isGrounded
	}
}