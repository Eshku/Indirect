/**
 * @fileoverview Implements a highly optimized Radix Sort for 64-bit integer keys.
 * This version uses a "ping-pong" buffering strategy to avoid memory allocations during passes.
 */

/**
 * Sorts an array of 64-bit keys and a parallel array of values in place.
 * @param {BigUint64Array} keys - The array of keys to sort.
 * @param {Uint32Array} values1 - The first parallel array of values (e.g., offsets).
 * @param {Uint16Array} [values2] - The second optional parallel array of values (e.g., lengths).
 */
export function radixSort(keys, values1, values2) {
    const n = keys.length;

    // Allocate temporary buffers once to avoid GC pressure during sorting.
    const tempKeys = new BigUint64Array(n);
    const tempValues1 = new Uint32Array(n);
    const tempValues2 = values2 ? new Uint16Array(n) : null;

    let currentKeys = keys;
    let currentValues1 = values1;
    let currentValues2 = values2;
    let nextKeys = tempKeys;
    let nextValues1 = tempValues1;
    let nextValues2 = tempValues2;

    // We'll sort 8 bits at a time, so we need 8 passes.
    for (let shift = 0; shift < 64; shift += 8) {
        countingSortByDigit(currentKeys, currentValues1, currentValues2, nextKeys, nextValues1, nextValues2, shift);

        // Ping-pong the buffers for the next pass.
        [currentKeys, nextKeys] = [nextKeys, currentKeys];
        [currentValues1, nextValues1] = [nextValues1, currentValues1];
        if (values2) [currentValues2, nextValues2] = [nextValues2, currentValues2];
    }

    // After all passes, the `currentKeys` buffer holds the fully sorted data.
    // If the number of passes is odd, the sorted data is in the temporary buffer.
    // In our case (8 passes, which is even), the sorted data is back in the original `keys` array.
    // If we had an odd number of passes, we would need to copy it back.
    if (currentKeys !== keys) {
        keys.set(currentKeys);
        values1.set(currentValues1);
        if (values2) values2.set(currentValues2);
    }
}

/**
 * A stable Counting Sort subroutine for one "digit" (8 bits) of the keys.
 * @param {BigUint64Array} inputKeys - The source array of keys.
 * @param {Uint32Array} inputValues1 - The source array of primary values.
 * @param {Uint16Array | null} inputValues2 - The source array of secondary values.
 * @param {BigUint64Array} outputKeys - The destination array for sorted keys.
 * @param {Uint32Array} outputValues1 - The destination array for sorted primary values.
 * @param {Uint16Array | null} outputValues2 - The destination array for sorted secondary values.
 * @param {number} shift - The bit shift to isolate the current digit.
 */
function countingSortByDigit(inputKeys, inputValues1, inputValues2, outputKeys, outputValues1, outputValues2, shift) {
    const n = inputKeys.length;
    const digitMask = 0xFFn; // Mask to get 8 bits
    const count = new Uint32Array(256).fill(0);

    // 1. Count occurrences of each digit in the input array.
    for (let i = 0; i < n; i++) {
        const digit = Number((inputKeys[i] >> BigInt(shift)) & digitMask);
        count[digit]++;
    }

    // 2. Calculate cumulative counts to determine the end position of each digit group.
    for (let i = 1; i < 256; i++) {
        count[i] += count[i - 1];
    }

    // 3. Build the output arrays by placing elements in sorted order.
    // Iterate backwards from the end of the input array to maintain stability.
    for (let i = n - 1; i >= 0; i--) {
        const key = inputKeys[i];
        const value1 = inputValues1[i];
        const value2 = inputValues2 ? inputValues2[i] : undefined;
        const digit = Number((key >> BigInt(shift)) & digitMask);

        // The new position is one less than the cumulative count.
        const position = count[digit] - 1;
        outputKeys[position] = key;
        outputValues1[position] = value1;
        if (value2 !== undefined) outputValues2[position] = value2;

        // Decrement the count for this digit for the next item with the same digit.
        count[digit]--;
    }
}