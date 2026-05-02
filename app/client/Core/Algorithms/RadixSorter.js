/**
 * Implements a Radix Sort for 64-bit integer keys.
 * This version uses a "ping-pong" buffering strategy to avoid memory allocations during passes.
 */

// A pre-allocated, reusable buffer for the counting sort histogram.
// This makes the radix sort function completely allocation-free during its execution.
const COUNT_BUFFER = new Uint32Array(256)
/**
 * Sorts an array of 64-bit keys and a parallel array of values in place.
 * @param {BigUint64Array} keys - The array of keys to sort.
 * @param {Uint32Array} values1 - The first parallel array of values (e.g., offsets).
 * @param {Uint16Array} values2 - The second optional parallel array of values (e.g., lengths).
 * @param {Uint32Array} values3 - The third optional parallel array of values (e.g., opCodesAndTypes).
 * @param {Uint32Array} values4 - The fourth optional parallel array of values (e.g., generations).
 * @param {BigUint64Array} tempKeys - A pre-allocated temporary buffer for keys.
 * @param {Uint32Array} tempValues1 - A pre-allocated temporary buffer for values1.
 * @param {Uint16Array} tempValues2 - A pre-allocated temporary buffer for values2.
 * @param {Uint32Array} tempValues3 - A pre-allocated temporary buffer for values3.
 * @param {Uint32Array} tempValues4 - A pre-allocated temporary buffer for values4.
 */
export function radixSort(keys, values1, values2, values3, values4, tempKeys, tempValues1, tempValues2, tempValues3, tempValues4) {
	// This is for 64-bit keys
    let currentKeys = keys;
    let currentValues1 = values1;
    let currentValues2 = values2;
    let currentValues3 = values3;
    let currentValues4 = values4;
    let nextKeys = tempKeys
    let nextValues1 = tempValues1
    let nextValues2 = tempValues2
    let nextValues3 = tempValues3
    let nextValues4 = tempValues4

    // We'll sort 8 bits at a time, so we need 8 passes.
    for (let shift = 0; shift < 64; shift += 8) {
        countingSortByDigit(currentKeys, currentValues1, currentValues2, currentValues3, currentValues4, nextKeys, nextValues1, nextValues2, nextValues3, nextValues4, shift);

        // Ping-pong the buffers for the next pass.
        [currentKeys, nextKeys] = [nextKeys, currentKeys];
        [currentValues1, nextValues1] = [nextValues1, currentValues1];
        if (currentValues2) [currentValues2, nextValues2] = [nextValues2, currentValues2];
        if (currentValues3) [currentValues3, nextValues3] = [nextValues3, currentValues3];
        if (currentValues4) [currentValues4, nextValues4] = [nextValues4, currentValues4];
    }

    // After all passes, the `currentKeys` buffer holds the fully sorted data.
    // If the number of passes is odd, the sorted data is in the temporary buffer.
    // In our case (8 passes, which is even), the sorted data is back in the original `keys` array.
    // If we had an odd number of passes, we would need to copy it back.
    if (currentKeys !== keys) {
        keys.set(currentKeys);
        values1.set(currentValues1);
        if (currentValues2) values2.set(currentValues2);
        if (currentValues3) values3.set(currentValues3);
        if (currentValues4) values4.set(currentValues4);
    }
}

/**
 * A stable Counting Sort subroutine for one "digit" (8 bits) of the keys.
 * @param {BigUint64Array} inputKeys - The source array of keys.
 * @param {Uint32Array} inputValues1 - The source array of primary values.
 * @param {Uint16Array | null} inputValues2 - The source array of secondary values.
 * @param {Uint32Array | null} inputValues3 - The source array of third values.
 * @param {Uint32Array | null} inputValues4 - The source array of fourth values.
 * @param {BigUint64Array} outputKeys - The destination array for sorted keys.
 * @param {Uint32Array} outputValues1 - The destination array for sorted primary values.
 * @param {Uint16Array | null} outputValues2 - The destination array for sorted secondary values.
 * @param {Uint32Array | null} outputValues3 - The destination array for sorted third values.
 * @param {Uint32Array | null} outputValues4 - The destination array for sorted fourth values.
 * @param {number} shift - The bit shift to isolate the current digit.
 */
function countingSortByDigit(inputKeys, inputValues1, inputValues2, inputValues3, inputValues4, outputKeys, outputValues1, outputValues2, outputValues3, outputValues4, shift) {
    const n = inputKeys.length;
    const digitMask = 0xFFn; // Mask to get 8 bits
    COUNT_BUFFER.fill(0)

    // 1. Count occurrences of each digit in the input array.
    for (let i = 0; i < n; i++) {
        const digit = Number((inputKeys[i] >> BigInt(shift)) & digitMask);
        COUNT_BUFFER[digit]++;
    }

    // 2. Calculate cumulative counts to determine the end position of each digit group.
    for (let i = 1; i < 256; i++) {
        COUNT_BUFFER[i] += COUNT_BUFFER[i - 1];
    }

    // 3. Build the output arrays by placing elements in sorted order.
    // Iterate backwards from the end of the input array to maintain stability.
    for (let i = n - 1; i >= 0; i--) {
        const key = inputKeys[i];
        const value1 = inputValues1[i];
        const value2 = inputValues2 ? inputValues2[i] : undefined;
        const value3 = inputValues3 ? inputValues3[i] : undefined;
        const value4 = inputValues4 ? inputValues4[i] : undefined;
        const digit = Number((key >> BigInt(shift)) & digitMask);

        // The new position is one less than the cumulative count.
        const position = COUNT_BUFFER[digit] - 1;
        outputKeys[position] = key;
        outputValues1[position] = value1;
        if (value2 !== undefined) outputValues2[position] = value2;
        if (value3 !== undefined) outputValues3[position] = value3;
        if (value4 !== undefined) outputValues4[position] = value4;

        // Decrement the count for this digit for the next item with the same digit.
        COUNT_BUFFER[digit]--;
    }
}

/**
 * A stable Counting Sort subroutine for one "digit" (8 bits) of the Uint32 keys.
 * This is a generic version that sorts a key array and a list of parallel typed arrays.
 */
function countingSortByDigit32(keys, parallelArrays, tempKeys, tempParallelArrays, shift) {
    const n = keys.length;
    const digitMask = 0xFF;
    COUNT_BUFFER.fill(0);

    // 1. Count occurrences of each digit.
    for (let i = 0; i < n; i++) {
        const digit = (keys[i] >> shift) & digitMask;
        COUNT_BUFFER[digit]++;
    }

    // 2. Calculate cumulative counts.
    for (let i = 1; i < 256; i++) {
        COUNT_BUFFER[i] += COUNT_BUFFER[i - 1];
    }

    // 3. Build the output arrays.
    for (let i = n - 1; i >= 0; i--) {
        const key = keys[i];
        const digit = (key >> shift) & digitMask;
        const position = --COUNT_BUFFER[digit]; // Pre-decrement to get the correct index

        tempKeys[position] = key;

        // Sort all parallel arrays
        for (let j = 0; j < parallelArrays.length; j++) {
            tempParallelArrays[j][position] = parallelArrays[j][i];
        }
    }
}

/**
 * Sorts an array of 32-bit keys and a set of parallel arrays.
 * This is a non-in-place sort; it requires temporary buffers of the same size.
 * The sorted result will be in the original input arrays.
 * @param {Uint32Array} keys - The array of keys to sort.
 * @param {TypedArray[]} parallelArrays - An array of other TypedArrays to sort along with the keys.
 * @param {Uint32Array} tempKeys - A pre-allocated temporary buffer for keys.
 * @param {TypedArray[]} tempParallelArrays - Pre-allocated temporary buffers for the parallel arrays.
 */
export function radixSort32(keys, parallelArrays, tempKeys, tempParallelArrays) {
    let currentKeys = keys;
    let currentParallel = parallelArrays;
    let nextKeys = tempKeys;
    let nextParallel = tempParallelArrays;

    // 4 passes for 32 bits (8 bits per pass)
    for (let shift = 0; shift < 32; shift += 8) {
        countingSortByDigit32(currentKeys, currentParallel, nextKeys, nextParallel, shift);

        // Ping-pong buffers
        [currentKeys, nextKeys] = [nextKeys, currentKeys];
        [currentParallel, nextParallel] = [nextParallel, currentParallel];
    }

    // We have 4 passes (even), so the sorted data is back in the original arrays.
}