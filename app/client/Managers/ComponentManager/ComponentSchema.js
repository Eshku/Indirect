/**
 * A standalone module that holds all compiled component schema data.
 * This data is generated at startup by ComponentManager and SchemaCompiler.
 *
 * By centralizing this static data, we decouple all other engine systems
 * from ComponentManager instance. Core modules like ArchetypeManager,
 * PayloadCompiler, and Chunk can import this data directly.
 */

export const TYPED_ARRAY_MAP = {
	float: Float64Array,
	int: Int32Array,
	integer: Int32Array,
	unsigned: Uint32Array,
	uint: Uint32Array,
	f64: Float64Array,
	f32: Float32Array,
	i32: Int32Array,
	u32: Uint32Array,
	i16: Int16Array,
	u16: Uint16Array,
	i8: Int8Array,
	u8: Uint8Array,
	bool: Uint8Array,
	boolean: Uint8Array, // Alias for u8
	u64: BigUint64Array,
	entity: BigUint64Array, // Explicit type for entity IDs
	string: Uint32Array, // Strings are stored as u32 references
	component: Uint16Array, // Component IDs are stored as u16 references
}

export const componentInfo = [] // Indexed by typeID, stores parsed schema info
export const componentConstants = [] // Indexed by typeID
export const compiledDefaults = [] // Indexed by typeID
export const componentBitFlags = [] // Indexed by typeID, stores BigInt bit flags
export const componentNames = [] // Indexed by typeID
export const componentNameToTypeID = new Map() // Maps lowercase name to typeID

export const MAX_COMPONENTS = 256
export const MASK_PARTS = Math.ceil(MAX_COMPONENTS / 64)
export const EMPTY_BITMASK = 0n
export const DIRTY_HISTORY_LENGTH = 64

export let nextComponentTypeID = 0
export const setNextComponentTypeID = id => (nextComponentTypeID = id)