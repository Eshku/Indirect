/**
 * A component that holds a managed reference to a visual asset, like a PIXI.Sprite.
 * This allows an entity to be represented visually on the screen. The actual sprite
 * object is stored and managed by the AssetManager.
 */

//! for serialization \ desir would need
//! store asset name too or map refs to names
//! idk, gonna figure it out at some point.
export class Viewable {
	/**
	 * The schema defines the data stored in the archetype's TypedArrays.
	 * `spriteRef` is a `u32` integer that acts as a handle to the actual
	 * PIXI.Sprite object in the AssetManager.
	 */
	static schema = {
		spriteRef: 'u32',
	}

	/**
	 * The constructor defines default values. It is NOT what is stored per-entity.
	 * @param {object} [data={}]
	 * @param {number} [data.spriteRef=0] - The reference to the sprite. 0 is a null reference.
	 */
	constructor({ spriteRef = 0 } = {}) {
		this.spriteRef = spriteRef
	}
}
