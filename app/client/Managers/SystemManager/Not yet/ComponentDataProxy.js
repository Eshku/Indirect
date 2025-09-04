/**
 * @fileoverview A zero-copy proxy for reading component data directly from the command buffer.
 */

export class ComponentDataProxy {
	/**
	 * @param {import('./CommandBufferReader.js').CommandBufferReader} reader
	 * @param {number} typeID
	 * @param {number} dataOffset
	 */
	constructor(reader, typeID, dataOffset) {
		const componentManager = reader.componentManager
		const info = componentManager.componentInfo[typeID]
		if (!info) {
			throw new Error(`Component info not found for typeID: ${typeID}`)
		}

		let currentPropertyOffset = 0
		const properties = {}

		for (const propKey of info.propertyKeys) {
			const propInfo = info.properties[propKey]
			const capturedOffset = dataOffset + currentPropertyOffset

			properties[propKey] = {
				get: () => {
					// read from buffer
					switch (propInfo.type) {
						case 'f64':
							return reader.view.getFloat64(capturedOffset, true)
						case 'f32':
							return reader.view.getFloat32(capturedOffset, true)
						case 'i32':
							return reader.view.getInt32(capturedOffset, true)
						case 'u32':
							return reader.view.getUint32(capturedOffset, true)
						case 'i16':
							return reader.view.getInt16(capturedOffset, true)
						case 'u16':
							return reader.view.getUint16(capturedOffset, true)
						case 'i8':
							return reader.view.getInt8(capturedOffset, true)
						case 'u8':
							return reader.view.getUint8(capturedOffset, true)
						default:
							throw new Error(`Unknown property type for deserialization: ${propInfo.type}`)
					}
				},
				enumerable: true,
			}

			currentPropertyOffset += propInfo.byteSize
		}

		Object.defineProperties(this, properties)
	}
}
