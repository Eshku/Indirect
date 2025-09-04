/**
 * @fileoverview Manages the sorting keys and offsets for the command buffer.
 */

import { radixSort } from '../../Core/Algorithms/RadixSorter.js';

const INITIAL_CAPACITY = 1024;

// --- Sort Key Structure ---
// | Bits 63-56 | Bits 55-48 | Bits 47-16      | Bits 15-0       |
// |------------|------------|-----------------|-----------------|
// | Phase (8)  | Layer (8)  | Primary ID (32) | Secondary ID (16) |

export const SortKeyLayout = {
    PHASE_SHIFT: 56n,
    LAYER_SHIFT: 48n,
    PRIMARY_ID_SHIFT: 16n,
    SECONDARY_ID_SHIFT: 0n,

    PHASE_MASK: 0xFFn << 56n,
    LAYER_MASK: 0xFFn << 48n,
    PRIMARY_ID_MASK: 0xFFFFFFFFn << 16n,
    SECONDARY_ID_MASK: 0xFFFFn,
};

export const SortPhase = {
    DESTROY: 0n,
    MODIFY: 128n,
    CREATE: 255n,
};

export class SortableCommandBuffer {
    constructor() {
        this.capacity = INITIAL_CAPACITY;
        this.size = 0;

        this.keysBuffer = new BigUint64Array(this.capacity);
        this.offsetsBuffer = new Uint32Array(this.capacity);
        this.lengthsBuffer = new Uint16Array(this.capacity); // To store command lengths
    }

    add(key, offset, length) {
        //console.log(`SortableCommandBuffer.add called. New size will be: ${this.size + 1}`);
        if (this.size >= this.capacity) {
            this.resize();
        }
        this.keysBuffer[this.size] = key;
        this.offsetsBuffer[this.size] = offset;
        this.lengthsBuffer[this.size] = length;
        this.size++;
    }

    sort() {
        // We only sort the part of the buffer that is actually used.
        const keysView = new BigUint64Array(this.keysBuffer.buffer, 0, this.size);
        const offsetsView = new Uint32Array(this.offsetsBuffer.buffer, 0, this.size);
        const lengthsView = new Uint16Array(this.lengthsBuffer.buffer, 0, this.size);
        radixSort(keysView, offsetsView, lengthsView);
    }

    getSortedOffsets() {
        return new Uint32Array(this.offsetsBuffer.buffer, 0, this.size);
    }

    getSortedLengths() {
        return new Uint16Array(this.lengthsBuffer.buffer, 0, this.size);
    }

    clear() {
        this.size = 0;
    }

    resize() {
        this.capacity *= 2;
        const newKeysBuffer = new BigUint64Array(this.capacity);
        const newOffsetsBuffer = new Uint32Array(this.capacity);
        const newLengthsBuffer = new Uint16Array(this.capacity);

        newKeysBuffer.set(this.keysBuffer);
        newOffsetsBuffer.set(this.offsetsBuffer);
        newLengthsBuffer.set(this.lengthsBuffer);

        this.keysBuffer = newKeysBuffer;
        this.offsetsBuffer = newOffsetsBuffer;
        this.lengthsBuffer = newLengthsBuffer;
    }

	static encodeKey(phase, layer, primaryId, secondaryId) {
		return (
			(BigInt(phase) << SortKeyLayout.PHASE_SHIFT) |
			(BigInt(layer) << SortKeyLayout.LAYER_SHIFT) |
			(BigInt(primaryId) << SortKeyLayout.PRIMARY_ID_SHIFT) |
			(BigInt(secondaryId) << SortKeyLayout.SECONDARY_ID_SHIFT)
		);
	}
}