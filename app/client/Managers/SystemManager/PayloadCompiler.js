/**
 * Compiles high-level entity data into low-level binary payloads.
 * This is a key part of the Zero-Overhead Data Pipeline, designed to eliminate
 * runtime object traversal and deserialization for entity creation.
 */

const { componentManager } = await import('../ComponentManager/ComponentManager.js');
const { archetypeManager } = await import('../ArchetypeManager/ArchetypeManager.js');
const { prefabManager } = await import('../PrefabManager/PrefabManager.js');
const { componentInterpreter } = await import('../ComponentManager/ComponentInterpreter.js');
const { stringInterningTable } = await import(`${PATH_CLIENT}/Indirection/StringInterningTable.js`);

class PayloadCompiler {
	/**
	 * The main compilation method. Takes a high-level description of an entity's
	 * components and data, and returns a low-level, pre-compiled payload object.
	 *
	 * @param {number} archetypeId - The target archetype for the entity.
	 * @param {Map<number, object>} componentDataMap - A map of componentTypeID to its high-level data object.
	 * @returns {{archetypeId: number, data: ArrayBuffer, mutators: object}} A frozen payload object.
	 */
	compileCreationPayload(archetypeId, componentDataMap) {
		const componentTypeIDs = archetypeManager.archetypeComponentTypeIDs[archetypeId]
		if (!componentTypeIDs) {
			throw new Error(`PayloadCompiler: Archetype with ID ${archetypeId} not found.`)
		}

		// --- 1. Calculate total size and offsets ---
		let totalByteSize = 0
		const componentOffsets = new Map()
		for (const typeID of componentTypeIDs) {
			const info = componentManager.componentInfo[typeID]
			if (!info) continue
			componentOffsets.set(typeID, totalByteSize)
			totalByteSize += info.byteSize
		}

		// --- 2. Allocate buffer and create DataView ---
		const payloadBuffer = new ArrayBuffer(totalByteSize)
		const payloadView = new DataView(payloadBuffer)

		// --- 3. Write data and create mutators ---
		const mutators = {}
		for (const typeID of componentTypeIDs) {
			const info = componentManager.componentInfo[typeID]
			const componentName = componentManager.getComponentNameByTypeID(typeID)
			const componentBaseOffset = componentOffsets.get(typeID)
			const initialData = componentDataMap.get(typeID) || {}
			const compiledDefaults = componentManager.getCompiledDefaults(typeID)

			mutators[componentName] = {}
			let currentPropertyByteOffset = 0

			// We must iterate over the original schema keys to correctly handle complex types
			// that are flattened into multiple properties.
			for (const originalPropKey of info.originalSchemaKeys) {
				const rep = info.representations[originalPropKey]
				if (!rep) continue

				// For complex types, the initial data is on the original key (e.g., 'tags'),
				// but the default data is on the flattened keys (e.g., 'tags0', 'tags1', ...).
				const highLevelValue = initialData[originalPropKey]

				switch (rep.type) {
					case 'flat_array': {
						const { capacity, lengthProperty, itemRepresentation } = rep
						const sourceArray = highLevelValue ?? compiledDefaults[originalPropKey] ?? []
						const liveLength = Math.min(sourceArray.length, capacity)

						// Write the flattened array data
						for (let i = 0; i < capacity; i++) {
							const flattenedKey = `${originalPropKey}${i}`
							const propInfo = info.properties[flattenedKey]
							const writeOffset = componentBaseOffset + currentPropertyByteOffset
							let valueToWrite = 0

							if (i < liveLength) {
								const rawValue = sourceArray[i]
								// Process string/enum values into their numeric representation
								if (itemRepresentation.type === 'string') {
									valueToWrite = stringInterningTable.intern(rawValue ?? '')
								} else if (itemRepresentation.type === 'enum') {
									valueToWrite = itemRepresentation.enumMap[rawValue] ?? 0
								} else {
									valueToWrite = rawValue ?? 0
								}
							}

							this._writeValue(payloadView, writeOffset, valueToWrite, propInfo.type)
							currentPropertyByteOffset += propInfo.arrayConstructor.BYTES_PER_ELEMENT
						}

						// Write the count property
						const lenPropInfo = info.properties[lengthProperty]
						const lenWriteOffset = componentBaseOffset + currentPropertyByteOffset
						this._writeValue(payloadView, lenWriteOffset, liveLength, lenPropInfo.type)
						currentPropertyByteOffset += lenPropInfo.arrayConstructor.BYTES_PER_ELEMENT

						// Create a single mutator for the whole flat array
						const arrayStartOffset = componentBaseOffset + info.properties[`${originalPropKey}0`].offset
						const arrayByteSize = info.properties[`${originalPropKey}0`].arrayConstructor.BYTES_PER_ELEMENT * capacity
						mutators[componentName][originalPropKey] = new (info.properties[`${originalPropKey}0`].arrayConstructor)(
							payloadBuffer,
							arrayStartOffset,
							capacity
						)
						mutators[componentName][lengthProperty] = new lenPropInfo.arrayConstructor(payloadBuffer, lenWriteOffset, 1)
						break
					}

					default: {
						// This handles primitives, string, enum, bitmask, etc.
						const propInfo = info.properties[originalPropKey]
						if (!propInfo) continue // Skip implicit properties like array counts

						let value = highLevelValue ?? compiledDefaults[originalPropKey]

						// Process high-level values (like 'JUMPING') into their numeric form
						const processedData = { [originalPropKey]: value }
						componentInterpreter.process(typeID, processedData)
						value = processedData[originalPropKey]

						const writeOffset = componentBaseOffset + currentPropertyByteOffset
						this._writeValue(payloadView, writeOffset, value, propInfo.type)

						// Create a mutator for this property
						mutators[componentName][originalPropKey] = new propInfo.arrayConstructor(payloadBuffer, writeOffset, 1)

						currentPropertyByteOffset += propInfo.arrayConstructor.BYTES_PER_ELEMENT
						break
					}
				}
			}
		}

		return Object.freeze({
			archetypeId,
			data: payloadBuffer,
			mutators: Object.freeze(mutators),
		})
	}

	/**
	 * An ergonomic helper to compile a creation payload from a simple, string-keyed object.
	 * This is the recommended API for use in system constructors.
	 * @param {object} componentDataObject - An object where keys are component names (e.g., `{ Position: {x: 10}, Velocity: {vx: 100} }`).
	 * @returns {{
	 *   archetypeId: number,
	 *   data: ArrayBuffer,
	 *   mutators: object
	 * }} A frozen payload object containing the binary data and a `mutators` object.
	 *
	 * @example
	 * // --- How to use Mutators ---
	 * // In a system's constructor, compile the payload once:
	 * this.projectilePayload = payloadCompiler.compileCreationPayloadFromObject({
	 *   Position: { x: 0, y: 0 }, // Initial values don't matter if they will be mutated
	 *   Velocity: { vx: 0, vy: 0 }
	 * });
	 *
	 * // In the update loop, use the mutators to update the payload's data with zero allocations:
	 * const { mutators, ...payload } = this.projectilePayload;
	 * mutators.Position.x[0] = player.x;
	 * mutators.Position.y[0] = player.y;
	 * mutators.Velocity.vx[0] = aimVector.x * 1000;
	 * this.commands.createEntities(payload, 1);
	 * @returns {ReturnType<compileCreationPayload>} A frozen payload object.
	 */
	compileCreationPayloadFromObject(componentDataObject) {
		// Use the existing manager utility to convert the string-keyed object to a typeID-keyed map.
		const componentDataMap = componentManager.createIdMapFromData(componentDataObject);
		// Determine the archetype from the provided components.
		const archetypeId = archetypeManager.getArchetype(componentDataMap.keys());
		// Call the original, high-performance compilation method.
		return this.compileCreationPayload(archetypeId, componentDataMap);
	}

	/**
	 * Compiles a payload for a prefab instance, applying overrides.
	 * @param {string} prefabName - The name of the prefab.
	 * @param {Map<number, object>} [overrides=new Map()] - High-level override data.
	 * @returns {ReturnType<compileCreationPayload>} A frozen payload object.
	 */
	compilePrefabPayload(prefabName, overrides = new Map()) {
		const prefabData = prefabManager.getPrefabData(prefabName)
		if (!prefabData) {
			throw new Error(`PayloadCompiler: Prefab '${prefabName}' not found.`)
		}

		// Convert prefab's name-keyed components to a typeID-keyed map
		const baseComponents = componentManager.createIdMapFromData(prefabData.components)

		// Merge overrides. Overrides take precedence.
		const finalComponents = new Map([...baseComponents, ...overrides])

		const archetypeMask = archetypeManager.generateArchetypeMask(finalComponents.keys())
		const archetypeId = archetypeManager.getArchetypeByMask(archetypeMask)

		return this.compileCreationPayload(archetypeId, finalComponents)
	}

	/**
	 * @private
	 * Helper to write a value to a DataView with the correct type.
	 */
	_writeValue(view, offset, value, type) {
		switch (type) {
			case 'f64':
				view.setFloat64(offset, value, true)
				break
			case 'f32':
				view.setFloat32(offset, value, true)
				break
			case 'i32':
				view.setInt32(offset, value, true)
				break
			case 'u32':
				view.setUint32(offset, value, true)
				break
			case 'i16':
				view.setInt16(offset, value, true)
				break
			case 'u16':
				view.setUint16(offset, value, true)
				break
			case 'i8':
				view.setInt8(offset, value)
				break
			case 'u8':
				view.setUint8(offset, value)
				break
			default:
				throw new Error(`PayloadCompiler: Unknown property type for writing: ${type}`)
		}
	}
}

export const payloadCompiler = new PayloadCompiler()