/**
 * A component that tracks the active cooldowns for an entity's shared skills.
 * This is more efficient than tracking cooldowns on every individual item entity.
 */
export class SharedCooldowns {
	constructor() {
		/**
		 * Maps a skill's prefabId to its remaining cooldown time in seconds.
		 * @type {Map<string, number>}
		 */
		this.cooldowns = new Map()
	}
}