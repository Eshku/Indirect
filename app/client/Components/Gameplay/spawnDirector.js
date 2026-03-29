/**
 * A singleton component that holds the state for the enemy spawning director.
 * The logic is handled by the `DirectorSystem`.
 */
export const spawnDirector = {
	/**
	 * The current "currency" the director has to spend on spawning enemies.
	 */
	threatBudget: { type: 'f32', default: 10.0 },
	/**
	 * The amount of threat budget gained per second.
	 */
	threatGrowthRate: { type: 'f32', default: 5.0 },
	/**
	 * The maximum amount of threat budget that can be accumulated.
	 */
	maxThreatBudget: { type: 'f32', default: 1000.0 },
	/**
	 * The minimum budget required to trigger a spawn wave.
	 */
	minSpawnBudget: { type: 'f32', default: 20.0 },
	/**
	 * The rate at which the threatGrowthRate itself increases per second.
	 * This makes the game progressively harder over time.
	 */
	threatGrowthEscalationRate: { type: 'f32', default: 0.1 },
}
