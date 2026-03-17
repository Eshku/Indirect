/**
 * Specifies the rendering layer an entity belongs to.
 * This component is used by factory systems to place visual objects
 * into the correct PIXI.Container.
 */
export const layer = {
	tracked: true,
	/**
	 * The name of the rendering layer.
	 * This must correspond to a layer created in the LayerManager.
	 * This will be interned by the String Interning Table.
	 */
	name: { type: 'string', default: 'enemies' },
}