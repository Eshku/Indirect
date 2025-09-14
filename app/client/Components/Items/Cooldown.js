/**
 * A component that defines the base cooldown duration for an item or skill.
 */
export const Cooldown = {
	/**
	 * The base cooldown duration in seconds.
	 * This is a perfect candidate for a shared property, as all instances
	 * of an item prefab will have the same base cooldown.
	 */
	duration: {
		type: 'f32',
		default: 0,
		shared: true,
	},
}
