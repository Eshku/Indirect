/**
 * A component that holds a PIXI.DisplayObject for rendering and its asset information.
 * This allows an entity to be represented visually on the screen. It's a generic
 * handle for any renderable object, whether it's a PIXI.Sprite, PIXI.Graphics, etc.
 */
export class Viewable {
	/**
	 * @param {object} data
	 * @param {PIXI.DisplayObject} data.view - The PIXI.DisplayObject instance (e.g., a PIXI.Sprite or PIXI.Graphics).
	 * @param {string} [data.assetName] - The name of the asset used to create this view, for serialization.
	 */
	constructor({ view, assetName } = {}) {
		this.view = view
		this.assetName = assetName
	}
}
