import { ComponentDataProxy } from './ComponentDataProxy.js'

/**
 * @fileoverview Reads and deserializes commands from a RawCommandBuffer.
 */

export class CommandBufferReader {
	/**
	 * @param {import('./RawCommandBuffer.js').RawCommandBuffer} rawBuffer
	 * @param {import('../ComponentManager/ComponentManager.js').ComponentManager} componentManager
	 */
	constructor(rawBuffer, componentManager) {
		this.buffer = rawBuffer.buffer
		this.view = new DataView(this.buffer)
		this.componentManager = componentManager
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
		//const value = this.view.getFloat32(this.offset, true);
		console.log(`Reader: readF32 at ${this.offset} value ${value}`)
		this.offset += 4
		return value
	}

	readF64() {
		const value = this.view.getFloat64(this.offset, true)
		//console.log(`Reader: readF64 at ${this.offset} value ${value}`);
		this.offset += 8
		return value
	}

	readComponentIdMap() {
		const map = new Map()
		const size = this.readU16()
		//console.log(`Reader: Map size: ${size}`);
		for (let i = 0; i < size; i++) {
			//console.log(`Reader: Reading component typeID for entry ${i} at ${this.offset}`);
			const typeID = this.readU16()
			// console.log(`Reader: Read typeID: ${typeID}`);

			// Read the byteSize from the buffer
			const componentDataSize = this.readU16() // Assuming byteSize was written as U16

			const info = this.componentManager.componentInfo[typeID]
			if (!info) throw new Error(`Component info not found for typeID: ${typeID}`)

			const data = new ComponentDataProxy(this, typeID, this.offset) // Creates proxy
			map.set(typeID, data)

			// Use the read componentDataSize to advance the offset
			//console.log(`Reader: Advancing offset by ${componentDataSize} for typeID ${typeID}. Old offset: ${this.offset}`);
			this.offset += componentDataSize
			//console.log(`Reader: New offset: ${this.offset}`);
		}

		return map // This is now a Map<typeID, dataOffset>
	}
}
