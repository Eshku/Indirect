/**
 * Formats a number of bytes into a human-readable string (B, KB, MB, GB).
 * @param {number} bytes - The number of bytes.
 * @returns {string} A formatted string.
 */
export function formatBytes(bytes) {
	if (bytes === 0) return '0 B'
	const k = 1024
	const sizes = ['B', 'KB', 'MB', 'GB']
	const i = Math.floor(Math.log(bytes) / Math.log(k))
	const value = parseFloat((bytes / Math.pow(k, i)).toPrecision(4))

	return `${value} ${sizes[i]}`
}