/**
 * Holds the state for an entity's jumping ability.
 */
export class Jump {
	static schema = {
		jumpForce: 'f32',
		wantsToJump: 'boolean',
	}
	/**
	 * @param {object} [data={}] - The initial data for the jump component.
	 * @param {number} [data.jumpForce=450] - The initial upward velocity for a jump in pixels/second.
	 * @param {boolean} [data.wantsToJump=false] - True if a jump action is currently intended.
	 */
	constructor({ jumpForce = 450, wantsToJump = false } = {}) {
		this.jumpForce = jumpForce
		this.wantsToJump = wantsToJump
	}
}