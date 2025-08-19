/**
 * A "hot" component that holds an entity's intent to perform an action,
 * typically set by an input system for players or an AI system for NPCs.
 */
export class ActionIntent {
	static schema = {
		actionIntent: 'boolean', // 'boolean' is an alias for 'u8'
	}

	/**
	 * @param {object} [data={}]
	 * @param {boolean} [data.actionIntent=false] A flag indicating the intent to use the currently selected action.
	 */
	constructor({ actionIntent = false } = {}) {
		this.actionIntent = actionIntent
	}
}