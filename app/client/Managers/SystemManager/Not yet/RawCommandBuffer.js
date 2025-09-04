/**
 * @fileoverview Manages a raw SharedArrayBuffer for serializing commands.
 * This is the low-level implementation detail of the command buffer system.
 * Systems should not interact with this directly, but through the high-level CommandBuffer API.
 */

const INITIAL_BUFFER_SIZE = 1024 * 1024 // 1 MB

export class RawCommandBuffer {
	/**
	 * @param {import('../ComponentManager/ComponentManager.js').ComponentManager} componentManager
	 */
	constructor(componentManager) {
		this.componentManager = componentManager
		this.buffer = new SharedArrayBuffer(INITIAL_BUFFER_SIZE)
		this.view = new DataView(this.buffer)
		this.offset = 0
	}

	/**
	 * Resets the buffer for the next frame.
	 */
	reset() {
		this.offset = 0
		// We can optionally clear the buffer if needed for debugging,
		// but it's not strictly necessary as we track the offset.
		// new Uint8Array(this.buffer).fill(0);
	}

	/**
	 * Ensures there is enough capacity in the buffer for the next write.
	 * @param {number} requiredSpace The number of bytes required.
	 */
	ensureCapacity(requiredSpace) {
		if (this.offset + requiredSpace > this.buffer.byteLength) {
			const newSize = Math.max(this.buffer.byteLength * 2, this.offset + requiredSpace)
			const newBuffer = new SharedArrayBuffer(newSize)
			new Uint8Array(newBuffer).set(new Uint8Array(this.buffer))
			this.buffer = newBuffer
			this.view = new DataView(this.buffer)
		}
	}

	writeU8(value) {
		//console.log(`RawBuffer: writeU8 at ${this.offset} value ${value}`);
		this.ensureCapacity(1)
		this.view.setUint8(this.offset, value)
		this.offset += 1
	}

	writeU16(value) {
		//console.log(`RawBuffer: writeU16 at ${this.offset} value ${value}`);
		this.ensureCapacity(2)
		this.view.setUint16(this.offset, value, true) // true for little-endian
		this.offset += 2
	}

	writeU32(value) {
		//console.log(`RawBuffer: writeU32 at ${this.offset} value ${value}`);
		this.ensureCapacity(4)
		this.view.setUint32(this.offset, value, true)
		this.offset += 4
	}

	writeI8(value) {
		//console.log(`RawBuffer: writeI8 at ${this.offset} value ${value}`);
		this.ensureCapacity(1)
		this.view.setInt8(this.offset, value)
		this.offset += 1
	}

	writeI16(value) {
		//console.log(`RawBuffer: writeI16 at ${this.offset} value ${value}`);
		this.ensureCapacity(2)
		this.view.setInt16(this.offset, value, true)
		this.offset += 2
	}

	writeI32(value) {
		//console.log(`RawBuffer: writeI32 at ${this.offset} value ${value}`);
		this.ensureCapacity(4)
		this.view.setInt32(this.offset, value, true)
		this.offset += 4
	}

	writeF32(value) {
		//console.log(`RawBuffer: writeF32 at ${this.offset} value ${value}`);
		this.ensureCapacity(4)
		this.view.setFloat32(this.offset, value, true)
		this.offset += 4
	}

	writeF64(value) {
		//console.log(`RawBuffer: writeF64 at ${this.offset} value ${value}`);
		this.ensureCapacity(8)
		this.view.setFloat64(this.offset, value, true)
		this.offset += 8
	}

	/**
	 * Serializes a component's data into the buffer based on its schema.
	 * @param {number} typeID The component's type ID.
	 * @param {object} data The component data object.
	 */
	writeComponentData(typeID, data) {
		//console.log(`RawBuffer: writeComponentData for typeID ${typeID} at ${this.offset}. Expected size: ${this.componentManager.componentInfo[typeID].byteSize}`);
		const info = this.componentManager.componentInfo[typeID]
		if (!info) throw new Error(`Component info not found for typeID: ${typeID}`)

		this.ensureCapacity(info.byteSize)

		for (const propKey of info.propertyKeys) {
			const propType = info.properties[propKey].type
			const value = data[propKey] ?? 0 // Default to 0 if undefined
			//console.log(`RawBuffer:   prop ${propKey} (${propType}) value ${value}`);
			switch (propType) {
				case 'f64':
					this.writeF64(value)
					break
				case 'f32':
					this.writeF32(value)
					break
				case 'i32':
					this.writeI32(value)
					break
				case 'u32':
					this.writeU32(value)
					break
				case 'i16':
					this.writeI16(value)
					break
				case 'u16':
					this.writeU16(value)
					break
				case 'i8':
					this.writeI8(value)
					break
				case 'u8':
					this.writeU8(value)
					break
				default:
					throw new Error(`Unknown property type for serialization: ${propType}`)
			}
		}
	}

	/**
	 * Serializes a map of component data in a canonical, sorted order.
	 * @param {Map<number, object>} map
	 */
	writeComponentIdMap(map) {
		//console.log('RawBuffer: --- Starting writeComponentIdMap ---');
		//console.log('RawBuffer: Map to write:', map);
		this.writeU16(map.size)
		const sortedEntries = [...map.entries()].sort((a, b) => a[0] - b[0])
		//console.log('RawBuffer: Sorted entries:', sortedEntries);

		for (const [typeID, data] of sortedEntries) {
			//console.log(`RawBuffer: Writing component typeID ${typeID} at ${this.offset}`);
			this.writeU16(typeID)

			// Get component info to retrieve byteSize
			const info = this.componentManager.componentInfo[typeID]
			if (!info) throw new Error(`Component info not found for typeID: ${typeID}`)

			// Write the byteSize of the component data
			this.writeU16(info.byteSize) // Assuming byteSize fits in U16, adjust if needed

			this.writeComponentData(typeID, data)
		}
	}
}
