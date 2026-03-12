/**
 * Specifies the rendering layer an entity belongs to.
 * This component is used by factory systems to place visual objects
 * into the correct PIXI.Container.
 */
export const Layer = {
	/**
	 * The name of the rendering layer.
	 * This must correspond to a layer created in the LayerManager.
	 * This will be interned by the String Interning Table.
	 */
	name: {
		type: 'string',
		default: 'enemies', // Default to a common layer.
	},
	/**
	 * The game tick when this component was last modified.
	 * Used for fine-grained reactive change detection.
	 */
	dirtyTick: { type: 'u32', default: 0 },
}