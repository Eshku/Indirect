/**
 * Reads and deserializes commands from a RawCommandBuffer.
 */

export class CommandBufferReader {
	/**
	 * @param {import('./RawCommandBuffer.js').RawCommandBuffer} rawBuffer
	 * @deprecated The constructor no longer accepts a buffer. Use `setBuffer()` instead.
	 */
	constructor() {
		this.buffer = null
		this.uint8View = null
		this.view = null
		this.offset = 0
	}

	setBuffer(rawBuffer) {
		this.buffer = rawBuffer.buffer
		this.uint8View = rawBuffer.uint8View
		this.view = new DataView(this.buffer, rawBuffer.buffer.byteOffset, rawBuffer.buffer.byteLength)
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
}
