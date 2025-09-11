/**
 * Manages a raw SharedArrayBuffer for serializing commands.
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

	writeU8At(offset, value) {
		this.view.setUint8(offset, value)
	}

	writeU16At(offset, value) {
		this.view.setUint16(offset, value, true)
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
	 * Writes a raw ArrayBuffer's contents into this command buffer.
	 * @param {ArrayBuffer} buffer - The buffer to write.
	 */
	writeBuffer(buffer) {
		this.ensureCapacity(buffer.byteLength)
		// Use a Uint8Array view for an efficient block copy.
		new Uint8Array(this.buffer).set(new Uint8Array(buffer), this.offset)
		this.offset += buffer.byteLength
	}
}
