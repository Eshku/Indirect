/**
 * @fileoverview Defines a descriptor for dynamically rendered shapes.
 */

/**
 * Describes a simple, dynamically-drawn shape for an entity.
 * This is used for "asset-less" rendering, like for projectiles, platforms, or debug shapes.
 */
export class ShapeDescriptor {
	// By defining a static schema, we tell the ECS to treat this as a "Hot" (SoA) component.
	// This is crucial for the high-performance, direct memory access used in rendering systems.
	static schema = {
		shape: 'string', // e.g., 'rectangle', 'circle'
		fillColor: 'string', // e.g., '0xffffff'
		outlineColor: 'string', // e.g., '0x333333'
		radius: 'f32',
		width: 'f32',
		height: 'f32',
		zIndex: 'i16',
	}

	constructor({
		shape = 'circle',
		fillColor = '0xffffff',
		outlineColor = '0x000000',
		radius = 10,
		width = 20,
		height = 20,
		zIndex = 0,
	} = {}) {
		// This constructor is not used to create stored instances for hot components.
		// It's here for documentation and for cases where you might create a
		// temporary descriptor object. The engine works directly with the schema
		// to manage data in TypedArrays.
		// Note: for a 'circle', only radius is used. For a 'rectangle', width and height are used.
		Object.assign(this, { shape, fillColor, outlineColor, radius, width, height, zIndex })
	}
}