/**
 * Linearly interpolates between two numbers.
 * @param {number} a - The start value.
 * @param {number} b - The end value.
 * @param {number} t - The interpolation factor (0-1).
 * @returns {number} The interpolated value.
 */
export function lerp(a, b, t) {
	return a + (b - a) * t
}

/**
 * Linearly interpolates between two colors.
 * This is a performant version that uses bitwise operations.
 * @param {number} start - The start color as a number (e.g., 0xff0000).
 * @param {number} end - The end color as a number (e.g., 0x0000ff).
 * @param {number} t - The interpolation factor (0-1).
 * @returns {number} The interpolated color as a number.
 */
export function lerpColor(start, end, t) {
	const r1 = (start >> 16) & 0xff
	const g1 = (start >> 8) & 0xff
	const b1 = start & 0xff

	const r2 = (end >> 16) & 0xff
	const g2 = (end >> 8) & 0xff
	const b2 = end & 0xff

	const r = (r1 + (r2 - r1) * t) | 0
	const g = (g1 + (g2 - g1) * t) | 0
	const b = (b1 + (b2 - b1) * t) | 0

	return (r << 16) | (g << 8) | b
}
