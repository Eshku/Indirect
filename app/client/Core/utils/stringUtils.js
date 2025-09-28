/**
 * Converts a PascalCase string to a smart camelCase, correctly handling acronyms at the start of the string.
 * - `Position` -> `position`
 * - `PlayerTag` -> `playerTag`
 * - `RWMTag` -> `rwmTag` (acronym at the start)
 * - `URLShortener` -> `urlShortener` (acronym followed by another word)
 * - `PlayerID` -> `playerID` (acronyms not at the start are treated as regular PascalCase)
 *
 * @param {string} str The PascalCase string to convert.
 * @returns {string} The camelCased string.
 */
export function toCamelCase(str) {
	if (!str) return ''

	// Match an initial acronym (e.g., "URL" in "URLShortener", "RWM" in "RWMTag").
	const acronymRegex = /^[A-Z0-9]+(?=[A-Z0-9][a-z]|$)/
	const match = str.match(acronymRegex)

	if (match) return match[0].toLowerCase() + str.slice(match[0].length)

	return str.charAt(0).toLowerCase() + str.slice(1)
}