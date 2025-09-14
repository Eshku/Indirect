/**
 * Destructures properties from a source object and assigns them to a target object (context).
 * This is a utility to reduce boilerplate in class constructors.
 *
 * @param {object} context - The `this` context of the class instance.
 * @param {object} source - The object to destructure properties from.
 * @param {string[]} keys - An array of property names to pick from the source and assign to the context.
 *
 * @example
 * // Instead of:
 * // const { Position, Velocity } = source;
 * // this.Position = Position;
 * // this.Velocity = Velocity;
 *
 * // You can do:
 * destructure(this, source, ['Position', 'Velocity']);
 *
 * // Now `this.Position` and `this.Velocity` are available.
 */
export function destructure(context, source, keys) {
	if (!source) {
		console.warn('Destructure called with a null or undefined source object.')
		return
	}

	for (const key of keys) {
		if (Object.prototype.hasOwnProperty.call(source, key)) {
			context[key] = source[key]
		} else {
			console.warn(`Destructure: key "${key}" not found in source object.`)
		}
	}
}

function destructureWithRename(context, source, mapping) {
	for (const sourceKey in mapping) {
		const targetKey = mapping[sourceKey]
		if (Object.prototype.hasOwnProperty.call(source, sourceKey)) {
			context[targetKey] = source[sourceKey]
		}
	}
}

// Usage:
/* destructureWithRename(this, componentManager.getTypeIDs(), {
	Owner: 'ownerTypeID',
	InActiveSet: 'inActiveSetTypeID',
	Prefab: 'prefabIdTypeID',
}) */
