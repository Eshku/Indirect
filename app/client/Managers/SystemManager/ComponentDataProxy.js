/**
 * @fileoverview A zero-copy proxy for reading component data directly from the command buffer's SharedArrayBuffer.
 * This avoids allocating intermediate JavaScript objects, reducing garbage collector pressure.
 *
 * ---
 * ### ARCHITECTURAL NOTE: The Performance Trade-Off of Proxies
 *
 * This file is currently **not used** by the `CommandBufferReader` and is kept as a reference
 * for a potential future optimization pattern.
 *
 * **The Goal:** The primary goal of a zero-copy proxy is to reduce Garbage Collector (GC) pressure.
 * When creating thousands of entities, the standard approach of deserializing component data into
 * new JavaScript objects (`{x: 10, y: 20}`) creates thousands of short-lived objects that the GC
 * must clean up, potentially causing frame rate stutters. This proxy avoids that by reading
 * data directly from the command buffer's memory when a property is accessed.
 *
 * **The Problem (Throughput vs. Smoothness):** Benchmarks revealed a significant trade-off.
 * While the proxy successfully reduces GC pressure (leading to a potentially smoother "marathon"),
 * it is significantly slower in raw throughput (the "sprint"). Accessing a property via the
 * proxy's `get` trap, which calls `DataView.getFloat32()`, has a higher overhead than a direct
 * property access on a plain JavaScript object that the JIT compiler can heavily optimize.
 * In high-frequency creation/destruction benchmarks, this overhead became the bottleneck.
 *
 * **The Path Forward:** The ultimate solution is a "direct buffer-to-buffer copy" approach, which
 * achieves both zero GC pressure and maximum throughput.  Until that is implemented, the direct
 * deserialization approach is favored for its higher raw performance.
 */

export class ComponentDataProxy {
	/**
	 * @param {import('./CommandBufferReader.js').CommandBufferReader} reader
	 * @param {number} typeID
	 * @param {number} dataOffset The starting offset of this component's data in the buffer.
	 */
	constructor(reader, typeID, dataOffset) {
		const componentManager = reader.componentManager
		const info = componentManager.componentInfo[typeID]
		if (!info) {
			throw new Error(`ComponentDataProxy: Component info not found for typeID: ${typeID}`)
		}

		let currentPropertyOffset = 0
		const properties = {}

		for (const propKey of info.propertyKeys) {
			const propSchema = info.properties[propKey]
			if (!propSchema) continue; // Skip properties like implicit array counts

			const capturedOffset = dataOffset + currentPropertyOffset

			properties[propKey] = {
				get: () => {
					switch (propSchema.type) {
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
							// This can happen for complex types like enums/strings which are stored as integers.
							// The raw integer value is returned, which is correct for this low-level proxy.
							return reader.view.getUint32(capturedOffset, true); // Assume u32 for unknown/complex types
					}
				},
				enumerable: true,
			}
			// Use the byte size from the array constructor for accuracy
			currentPropertyOffset += propSchema.arrayConstructor.BYTES_PER_ELEMENT;
		}

		Object.defineProperties(this, properties)
	}
}
