import * as Schema from './ComponentSchema.js'

/**
 * Retrieves the static constant map (for enums or bitmasks) for a specific component.
 * This is a standalone, thread-safe-friendly accessor.
 * @param {string|number} componentIdentifier - The component name or typeID.
 * @returns {object | undefined} The read-only constant map (e.g., `{ STATE: { IDLE: 0, ... } }`), or undefined if not found.
 */
export function getConstantsFor(componentIdentifier) {
	const typeID =
		typeof componentIdentifier === 'string'
			? Schema.componentNameToTypeID.get(componentIdentifier.toLowerCase())
			: componentIdentifier
	if (typeID === undefined) return undefined
	return Schema.componentConstants[typeID]
}

/**
 * Retrieves the static constant map (for enums or bitmasks) for a specific property of a component.
 * This is a standalone, thread-safe-friendly accessor.
 * @param {string|number} componentIdentifier - The name or typeID of the component.
 * @param {string} propertyName - The name of the property in the component's schema (e.g., 'flags').
 * @returns {object | undefined} The read-only constant map (e.g., `{ LEFT: 1, RIGHT: 2, ... }`), or undefined if not found.
 */
export function getConstantsForProperty(componentIdentifier, propertyName) {
	const componentConstants = getConstantsFor(componentIdentifier)
	if (!componentConstants) {
		return undefined
	}

	const propertyConstants = componentConstants[propertyName.toUpperCase()]
	return propertyConstants
}