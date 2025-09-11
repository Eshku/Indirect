/**
 * A component that defines stackable behavior for items or abilities.
 */
export const Stack = {
	/**
	 * The maximum size of the stack. This is often shared among all instances of a particular item type.
	 */
	size: {
		type: 'u16',
		shared: true,
		default: 1,
	},
	/**
	 * The current number of items in this specific stack.
	 */
	amount: {
		type: 'u16',
		default: 1,
	},
}
