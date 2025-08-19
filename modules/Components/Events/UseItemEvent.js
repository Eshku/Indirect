/**
 * An event component created when an entity intends to use an item.
 * This component is a "cold" component because its data is complex and it's
 * processed by a single system (`EffectExecutionSystem`) and then destroyed.
 * It acts as a message carrying all necessary data for an action to be resolved.
 */
export class UseItemEvent {
	// No static schema = this is a "cold" component (Array-of-Structs).

	/**
	 * @param {object} [data={}] - The initial data for the event.
	 * @param {number} data.ownerId - The entity ID of the item's owner/user.
	 * @param {object} data.target - The target data (e.g., { position: {x, y} }, { direction: {x, y} }).
	 * @param {object} data.ownerStatsSnapshot - A snapshot of the owner's relevant stats at the time of use.
	 * @param {Array<object>} data.effects - A deep copy of the item's effects to be executed.
	 */
	constructor({ ownerId = -1, target = null, ownerStatsSnapshot = {}, effects = [] } = {}) {
		/**
		 * The entity ID of the item's owner/user.
		 * @type {number}
		 */
		this.ownerId = ownerId

		/**
		 * The target data for the action.
		 * @type {object}
		 */
		this.target = target

		/**
		 * A snapshot of the owner's relevant stats (e.g., Strength, MaxHealth)
		 * at the moment the item was used. This ensures that effects are calculated
		 * based on the stats at the time of action, not when the effect resolves.
		 * @type {object}
		 */
		this.ownerStatsSnapshot = ownerStatsSnapshot

		/**
		 * A deep copy of the item's effects array.
		 * @type {Array<object>}
		 */
		this.effects = effects
	}
}