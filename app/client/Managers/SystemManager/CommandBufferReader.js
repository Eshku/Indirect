/**
 * @fileoverview Reads and deserializes commands from a RawCommandBuffer.
 */
import { ComponentDataProxy } from './ComponentDataProxy.js';

const textDecoder = new TextDecoder();
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
		const value = this.view.getFloat32(this.offset, true);
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

	readString() {
        const length = this.readU16();
        if (this.offset + length > this.buffer.byteLength) throw new Error("Buffer read overflow");
        const stringBytes = new Uint8Array(this.buffer, this.offset, length);
        const value = textDecoder.decode(stringBytes);
        this.offset += length;
        return value;
    }

	/**
	 * Reads and fully deserializes a component's data from the current offset.
	 * @param {number} typeID The component's type ID.
	 * @returns {object} The deserialized component data.
	 */
	readComponentData(typeID) {
		const info = this.componentManager.componentInfo[typeID];
		if (!info) throw new Error(`Component info not found for typeID: ${typeID}`);

		const data = {};
		for (const propKey of info.propertyKeys) {
			const propType = info.properties[propKey].type;
			switch (propType) {
				case 'f64': data[propKey] = this.readF64(); break;
				case 'f32': data[propKey] = this.readF32(); break;
				case 'i32': data[propKey] = this.readI32(); break;
				case 'u32': data[propKey] = this.readU32(); break;
				case 'i16': data[propKey] = this.readI16(); break;
				case 'u16': data[propKey] = this.readU16(); break;
				case 'i8': data[propKey] = this.readI8(); break;
				case 'u8': data[propKey] = this.readU8(); break;
				default:
					throw new Error(`Unknown property type for deserialization: ${propType}`);
			}
		}
		return data;
	}

	readComponentIdMap() {
		const map = new Map()
		const size = this.readU16()
		//console.log(`Reader: Map size: ${size}`);
		for (let i = 0; i < size; i++) {
			const typeID = this.readU16();
			const componentDataSize = this.readU16(); // Read the byteSize of the data block

			// Create a zero-copy proxy for the data instead of a full object.
			const proxy = new ComponentDataProxy(this, typeID, this.offset);
			map.set(typeID, proxy);

			// Advance the reader's offset past this component's data block.
			this.offset += componentDataSize;
		}

		return map
	}
}
