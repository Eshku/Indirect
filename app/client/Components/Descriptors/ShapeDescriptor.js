/**
 * Defines a descriptor for dynamically rendered shapes.
 */

/**
 * Describes a simple, dynamically-drawn shape for an entity.
 * This is used for "asset-less" rendering, like for projectiles, platforms, or debug shapes.
 */
export const ShapeDescriptor = {
	/** The type of shape to draw (e.g., 'rectangle', 'circle'). */
	shape: { type: 'string', default: 'circle' },
	/** The fill color of the shape as a hex string. */
	fillColor: { type: 'string', default: '0xffffff' },
	/** The outline color of the shape as a hex string. */
	outlineColor: { type: 'string', default: '0x000000' },
	/** The radius of the shape (if it's a circle). */
	radius: { type: 'f32', default: 10 },
	/** The width of the shape (if it's a rectangle). */
	width: { type: 'f32', default: 20 },
	/** The height of the shape (if it's a rectangle). */
	height: { type: 'f32', default: 20 },
	/** The z-index for rendering order. */
	zIndex: { type: 'i16', default: 0 },
}
