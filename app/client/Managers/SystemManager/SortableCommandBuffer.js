/**
 * Manages the sorting keys and offsets for the command buffer.
 */

import { radixSort } from '../../Core/Algorithms/RadixSorter.js'

const INITIAL_CAPACITY = 1024

// --- Sort Key Structure ---
// The key is designed for correctness and performance.
// | Bits 63-56 | Bits 55-48 | Bits 47-16         | Bits 15-0   |
// |------------|------------|--------------------|-------------|
// | Phase (8)  | Layer (8)  | Entity Index (32)  | SubKey (16) |

export const SortKeyLayout = {
	PHASE_SHIFT: 56n,
	LAYER_SHIFT: 48n,
	ENTITY_INDEX_SHIFT: 16n,
	SUB_KEY_SHIFT: 0n,

	PHASE_MASK: 0xffn << 56n,
	LAYER_MASK: 0xffn << 48n,
	ENTITY_INDEX_MASK: 0xffffffffn << 16n,
	SUB_KEY_MASK: 0xffffn,
}

export const SortPhase = {
	CREATE: 0,
	MODIFY: 128,
	DESTROY: 255,
}

export class SortableCommandBuffer {
	constructor() {
		this.capacity = INITIAL_CAPACITY
		this.size = 0
 
		this.keysBuffer = new BigUint64Array(this.capacity)
		this.offsetsBuffer = new Uint32Array(this.capacity)
		this.lengthsBuffer = new Uint16Array(this.capacity)
		this.opCodesAndTypesBuffer = new Uint32Array(this.capacity)
		this.generationsBuffer = new Uint32Array(this.capacity)

		// Pre-allocate temp buffers for sorting to avoid allocation in the hot path.
		this.tempKeysBuffer = new BigUint64Array(this.capacity)
		this.tempOffsetsBuffer = new Uint32Array(this.capacity)
		this.tempLengthsBuffer = new Uint16Array(this.capacity)
		this.tempOpCodesAndTypesBuffer = new Uint32Array(this.capacity)
		this.tempGenerationsBuffer = new Uint32Array(this.capacity)
	}

	add(key, offset, length, opAndType, generation) {
		if (this.size >= this.capacity) {
			this.resize()
		}
		this.keysBuffer[this.size] = key
		this.offsetsBuffer[this.size] = offset
		this.lengthsBuffer[this.size] = length
		this.opCodesAndTypesBuffer[this.size] = opAndType
		this.generationsBuffer[this.size] = generation
		this.size++
	}

	sort() {
		// We only sort the part of the buffer that is actually used.
		const keysView = new BigUint64Array(this.keysBuffer.buffer, 0, this.size)
		const offsetsView = new Uint32Array(this.offsetsBuffer.buffer, 0, this.size)
		const lengthsView = new Uint16Array(this.lengthsBuffer.buffer, 0, this.size)
		const opCodesAndTypesView = new Uint32Array(this.opCodesAndTypesBuffer.buffer, 0, this.size)
		const generationsView = new Uint32Array(this.generationsBuffer.buffer, 0, this.size)

		const tempKeysView = new BigUint64Array(this.tempKeysBuffer.buffer, 0, this.size)
		const tempOffsetsView = new Uint32Array(this.tempOffsetsBuffer.buffer, 0, this.size)
		const tempLengthsView = new Uint16Array(this.tempLengthsBuffer.buffer, 0, this.size)
		const tempOpCodesAndTypesView = new Uint32Array(this.tempOpCodesAndTypesBuffer.buffer, 0, this.size)
		const tempGenerationsView = new Uint32Array(this.tempGenerationsBuffer.buffer, 0, this.size)

		radixSort(
			keysView, offsetsView, lengthsView, opCodesAndTypesView, generationsView,
			tempKeysView, tempOffsetsView, tempLengthsView, tempOpCodesAndTypesView, tempGenerationsView
		)
	}

	getSortedKeys() {
		return new BigUint64Array(this.keysBuffer.buffer, 0, this.size)
	}

	getSortedOffsets() {
		return new Uint32Array(this.offsetsBuffer.buffer, 0, this.size)
	}

	getSortedLengths() {
		return new Uint16Array(this.lengthsBuffer.buffer, 0, this.size)
	}

	getSortedOpCodesAndTypes() {
		return new Uint32Array(this.opCodesAndTypesBuffer.buffer, 0, this.size)
	}

	getSortedGenerations() {
		return new Uint32Array(this.generationsBuffer.buffer, 0, this.size)
	}

	clear() {
		this.size = 0
	}

	resize() {
		this.capacity *= 2
		const newKeysBuffer = new BigUint64Array(this.capacity)
		const newOffsetsBuffer = new Uint32Array(this.capacity)
		const newLengthsBuffer = new Uint16Array(this.capacity)
		const newOpCodesAndTypesBuffer = new Uint32Array(this.capacity)
		const newGenerationsBuffer = new Uint32Array(this.capacity)
		const newTempKeysBuffer = new BigUint64Array(this.capacity)
		const newTempOffsetsBuffer = new Uint32Array(this.capacity)
		const newTempLengthsBuffer = new Uint16Array(this.capacity)
		const newTempOpCodesAndTypesBuffer = new Uint32Array(this.capacity)
		const newTempGenerationsBuffer = new Uint32Array(this.capacity)

		newKeysBuffer.set(this.keysBuffer)
		newOffsetsBuffer.set(this.offsetsBuffer)
		newLengthsBuffer.set(this.lengthsBuffer)
		newOpCodesAndTypesBuffer.set(this.opCodesAndTypesBuffer)
		newGenerationsBuffer.set(this.generationsBuffer)

		newTempKeysBuffer.set(this.tempKeysBuffer)
		newTempOffsetsBuffer.set(this.tempOffsetsBuffer)
		newTempLengthsBuffer.set(this.tempLengthsBuffer)
		newTempOpCodesAndTypesBuffer.set(this.tempOpCodesAndTypesBuffer)
		newTempGenerationsBuffer.set(this.tempGenerationsBuffer)

		this.keysBuffer = newKeysBuffer
		this.offsetsBuffer = newOffsetsBuffer
		this.lengthsBuffer = newLengthsBuffer
		this.opCodesAndTypesBuffer = newOpCodesAndTypesBuffer
		this.generationsBuffer = newGenerationsBuffer

		this.tempKeysBuffer = newTempKeysBuffer
		this.tempOffsetsBuffer = newTempOffsetsBuffer
		this.tempLengthsBuffer = newTempLengthsBuffer
		this.tempOpCodesAndTypesBuffer = newTempOpCodesAndTypesBuffer
		this.tempGenerationsBuffer = newTempGenerationsBuffer
	}

	static encodeKey(phase, layer, entityIndex, subKey) {
		return (
			(BigInt(phase) << SortKeyLayout.PHASE_SHIFT) |
			(BigInt(layer) << SortKeyLayout.LAYER_SHIFT) |
			(BigInt(entityIndex) << SortKeyLayout.ENTITY_INDEX_SHIFT) |
			(BigInt(subKey) << SortKeyLayout.SUB_KEY_SHIFT)
		)
	}
}
