/**
 * Manages a raw SharedArrayBuffer for serializing commands.
 * This is the low-level implementation detail of the command buffer system.
 * Systems should not interact with this directly, but through the high-level CommandBuffer API.
 */

const INITIAL_BUFFER_SIZE = 1024 * 1024 // 1 MB

export class RawCommandBuffer {

	constructor() {
		this.buffer = new SharedArrayBuffer(INITIAL_BUFFER_SIZE)
		this.view = new DataView(this.buffer)
		this.uint8View = new Uint8Array(this.buffer) // For faster string/buffer ops
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
			new Uint8Array(newBuffer).set(this.uint8View)
			this.buffer = newBuffer
			this.uint8View = new Uint8Array(this.buffer)
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

	writeU64(value) {
		//console.log(`RawBuffer: writeU64 at ${this.offset} value ${value}`);
		this.ensureCapacity(8)
		this.view.setBigUint64(this.offset, value, true) // true for little-endian
		this.offset += 8
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
		this.uint8View.set(new Uint8Array(buffer), this.offset)
		this.offset += buffer.byteLength
	}

	/**
	 * Writes a string to the buffer, prefixed with its length.
	 * @param {string} str The string to write.
	 */
	writeString(str) {
		// Note: This uses a simple TextEncoder. For extreme performance,
		// a pre-computed string hash (like FNV-1a) would be faster.
		const encoded = new TextEncoder().encode(str)
		this.ensureCapacity(2 + encoded.length)
		this.writeU16(encoded.length)
		this.uint8View.set(encoded, this.offset)
		this.offset += encoded.length
	}

	readString() {
		const length = this.view.getUint16(this.offset, true)
		this.offset += 2
		const strBytes = this.uint8View.subarray(this.offset, this.offset + length)
		this.offset += length
		return new TextDecoder().decode(strBytes)
	}

	readBuffer(byteLength) {
		this.ensureCapacity(byteLength) // Should not be needed if writer ensures capacity
		const bufferSlice = this.buffer.slice(this.offset, this.offset + byteLength)
		this.offset += byteLength
		return bufferSlice
	}

	seek(offset) {
		this.offset = offset
	}
}
