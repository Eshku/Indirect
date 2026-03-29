/**
 * A component to hold AI-related parameters for an entity,
 * allowing for per-entity or per-prefab behavior tuning.
 */
export const aiParameters = {
	/**
	 * Controls how much an entity orbits versus moving directly towards its target.
	 * A value of 0 means a direct path.
	 * A higher value (e.g., 0.8) results in a wider, spiraling path.
	 */
	orbitBias: { type: 'f32', default: 0.4 },
	/**
	 * Controls the angular spread of the orbiting path, in radians.
	 * A value of 0 means the tangent is perfectly perpendicular. A higher value (e.g., Math.PI/4) introduces a wobble.
	 */
	orbitAngleSpread: { type: 'f32', default: 0.0 }, // Controls the angular deviation of the tangent
	/**
	 * The frequency of the time-based "wobble" in the entity's path.
	 * A value of 0 results in a static path. Higher values create faster oscillation.
	 */
	orbitWobbleFrequency: { type: 'f32', default: 0.0 },
}
