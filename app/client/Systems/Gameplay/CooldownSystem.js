const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { cooldownManager } = theManager.getManagers()

/**
 * A system that updates all active cooldowns in the CooldownManager.
 *
 * This system runs on the fixed 'logic' timestep, ensuring that cooldowns
 * are processed deterministically and in sync with the rest of the game's
 * simulation. It simply calls the manager's update method, passing in the
 * frame's `deltaTime`.
 */
export class CooldownSystem {
	constructor() {
		this.cooldownManager = cooldownManager
	}

	update(deltaTime) {
		this.cooldownManager.update(deltaTime)
	}
}