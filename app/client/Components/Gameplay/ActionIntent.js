/**
 * A component that holds an entity's intent to perform an action,
 * typically set by an input system for players or an AI system for NPCs.
 */
export const ActionIntent = {
	/**
	 * A flag indicating the intent to use the currently selected action.
	 */
	actionIntent: {
		type: 'boolean',
		default: false,
	},
}
