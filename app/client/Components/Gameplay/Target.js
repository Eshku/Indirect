/**
 * A component representing the target of an action or effect.
 * This uses a "tagged union" pattern, where the `type` property
 * determines which of the other properties are relevant.
 */

/* 
    enum is stored as a raw integer index.
    type:            Uint8Array[entity0, entity1, entity2, ...],

     Other properties from the schema
    entityId:        Uint32Array[entity0, entity1, entity2, ...],
    x:               Float64Array[entity0, entity1, entity2, ...],
    y:               Float64Array[entity0, entity1, entity2, ...]

*/

export const Target = {
	/** The type of target. */
	type: {
		type: 'enum',
		of: {
			None: 0,
			Entity: 1,
			Position: 2,
			Direction: 3,
		},
		default: 'None',
	},
	/** The entity ID, if type is 'Entity'. */
	entityId: {
		type: 'entity',
		default: 0n,
	},
	/** The X coordinate or direction component. */
	x: {
		type: 'f64',
		default: 0,
	},
	/** The Y coordinate or direction component. */
	y: {
		type: 'f64',
		default: 0,
	},
}
