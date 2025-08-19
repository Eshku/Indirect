/**
 * @fileoverview A dedicated parser for transforming designer-friendly prefab data
 * into a runtime-optimized format by resolving string-based enums.
 * This parser is driven by component schemas, making it generic and extensible.
 */

// We use the ComponentManager as the single source of truth for component schemas.
const { componentManager } = await import(`${PATH_MANAGERS}/ComponentManager/ComponentManager.js`)

/**
 * Parses an array of child entity definitions, resolving any string-based enums
 * into their runtime integer equivalents by looking up component schemas.
 * This mutation happens in-place.
 * @param {Array<object>} children - The array of child entity definitions to parse.
 */
export function parsePrefab(children) {
	_resolveEnumsRecursive(children)
}

/**
 * Recursively traverses an array of child entity definitions and their components,
 * replacing string enum values with their corresponding integer values based on
 * schemas from the component registry.
 * @param {Array<object>} children - The array of child entity definitions.
 * @private
 */
function _resolveEnumsRecursive(children) {
	if (!children || !Array.isArray(children)) {
		return
	}

	for (const child of children) {
		if (child.components) {
			for (const componentName in child.components) {
				const ComponentClass = componentManager.getComponentClassByName(componentName)

				// If the component isn't registered or has no schema, there's nothing to parse.
				if (!ComponentClass || !ComponentClass.schema) continue

				const componentData = child.components[componentName]
				if (typeof componentData === 'object' && componentData !== null) {
					for (const propName in componentData) {
						// The SchemaParser creates a static uppercase map (e.g., Trigger.ON) for enums.
						const staticEnumMap = ComponentClass[propName.toUpperCase()]

						if (staticEnumMap && typeof componentData[propName] === 'string') {
							const stringValue = componentData[propName]
							if (Object.prototype.hasOwnProperty.call(staticEnumMap, stringValue)) {
								componentData[propName] = staticEnumMap[stringValue]
							} else {
								console.warn(
									`PrefabParser: Invalid enum value "${stringValue}" for property "${propName}" in component "${componentName}". Valid values are: ${Object.keys(
										staticEnumMap
									).join(', ')}`
								)
							}
						}
					}
				}
			}
		}

		if (child.children) {
			_resolveEnumsRecursive(child.children)
		}
	}
}