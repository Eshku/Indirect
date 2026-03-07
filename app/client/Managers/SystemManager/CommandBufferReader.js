/**
 * Reads and deserializes commands from a RawCommandBuffer.
 */

export class CommandBufferReader {
	/**
	 * @param {import('./RawCommandBuffer.js').RawCommandBuffer} rawBuffer
	 */
	constructor(rawBuffer) {
		this.buffer = rawBuffer.buffer
		this.view = new DataView(this.buffer)
		this.offset = 0
	}

	seek(offset) {
		this.offset = offset
		//console.log(`Reader: Seeking to offset ${offset}`);
	}

	readU8() {
		const value = this.view.getUint8(this.offset)
		//console.log(`Reader: readU8 at ${this.offset} value ${value}`);
		this.offset += 1
		return value
	}

	readU16() {
		const value = this.view.getUint16(this.offset, true)
		//console.log(`Reader: readU16 at ${this.offset} value ${value}`);
		this.offset += 2
		return value
	}

	readU32() {
		const value = this.view.getUint32(this.offset, true)
		//console.log(`Reader: readU32 at ${this.offset} value ${value}`);
		this.offset += 4
		return value
	}

	readU64() {
		const value = this.view.getBigUint64(this.offset, true)
		//console.log(`Reader: readU64 at ${this.offset} value ${value}`);
		this.offset += 8
		return value
	}

	readI8() {
		const value = this.view.getInt8(this.offset)
		//console.log(`Reader: readI8 at ${this.offset} value ${value}`);
		this.offset += 1
		return value
	}

	readI16() {
		const value = this.view.getInt16(this.offset, true)
		//console.log(`Reader: readI16 at ${this.offset} value ${value}`);
		this.offset += 2
		return value
	}

	readI32() {
		const value = this.view.getInt32(this.offset, true)
		//console.log(`Reader: readI32 at ${this.offset} value ${value}`);
		this.offset += 4
		return value
	}

	readF32() {
		const value = this.view.getFloat32(this.offset, true)
		//console.log(`Reader: readF32 at ${this.offset} value ${value}`)
		this.offset += 4
		return value
	}

	readF64() {
		const value = this.view.getFloat64(this.offset, true)
		//console.log(`Reader: readF64 at ${this.offset} value ${value}`);
		this.offset += 8
		return value
	}

	/**
	 * Reads a block of bytes from the buffer into a new ArrayBuffer.
	 * @param {number} size - The number of bytes to read.
	 * @returns {ArrayBuffer} A new ArrayBuffer containing the data.
	 */
	readBuffer(size) {
		// Create a slice (a view) of the underlying buffer without copying.
		const slice = this.buffer.slice(this.offset, this.offset + size)
		this.offset += size
		// Return a copy so the original buffer can be reused without affecting the payload.
		return slice
	}
}
