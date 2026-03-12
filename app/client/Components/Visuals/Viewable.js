/**
 * A component that holds a managed reference to a visual asset, like a PIXI.Sprite.
 * This allows an entity to be represented visually on the screen. The actual sprite
 * object is stored and managed by the AssetManager.
 */

//! for serialization \ desir would need
//! store asset name too or map refs to names
//! idk, gonna figure it out at some point.
export const Viewable = {
	/**
	 * The reference (handle) to the actual PIXI.DisplayObject in the AssetManager's pool.
	 * A value of 0 is considered a null reference.
	 */
	spriteRef: {
		type: 'u32',
		default: 0,
	},
	/**
	 * The game tick when this component was last modified.
	 * Used for fine-grained reactive change detection.
	 */
	dirtyTick: { type: 'u32', default: 0 },
}
