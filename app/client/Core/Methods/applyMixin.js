/**
 * A utility to apply mixins to a class by shallow-copying properties.
 *
 * This function copies all own properties (including non-enumerable ones and accessors)
 * from the prototype of each mixin to the target class's prototype. It also copies
 * all static properties from the mixin class to the target class.
 *
 * @remarks
 * This is a simple and effective way to share behavior between classes without
 * using traditional inheritance. However, it has important limitations.
 *
 * **Limitations:**
 * 1.  **No `super` Calls:** Methods in the mixin cannot use `super` to call
 *     methods on the target class, as the prototype chain is not modified.
 * 2.  **Property Collisions:** If multiple mixins define a property with the
 *     same name, the last mixin applied will silently overwrite the previous ones.
 * 3.  **`instanceof` Ineffective:** An instance of the target class will not be
 *     considered an `instanceof` the mixin class.
 * 4.  **Constructor Ignored:** The constructor of the mixin class is not executed.
 *     Any initialization logic must be handled by an explicit method (e.g., `init()`)
 *     that is called from the target class's constructor.
 *
 * @param {Function} targetClass The class to apply the mixins to.
 * @param {...Function} mixinClasses The mixin classes whose properties will be copied.
 *
 * @example
 * class CanFly {
 *   fly() { console.log('Flying!'); }
 *   static get WING_TYPE() { return 'Feathered'; }
 * }
 *
 * class Hero {
 *   constructor(name) { this.name = name; }
 * }
 *
 * applyMixin(Hero, CanFly);
 *
 * const superman = new Hero('Superman');
 * superman.fly(); // Outputs: "Flying!"
 * console.log(Hero.WING_TYPE); // Outputs: "Feathered"
 */
export const applyMixin = (targetClass, ...mixinClasses) => {
	mixinClasses.forEach(mixinClass => {
		// Copy prototype methods and accessors (e.g., getters/setters)
		Object.getOwnPropertyNames(mixinClass.prototype).forEach(name => {
			if (name !== 'constructor') {
				const descriptor = Object.getOwnPropertyDescriptor(mixinClass.prototype, name)
				// Define the property on the target class's prototype
				if (descriptor) {
					Object.defineProperty(targetClass.prototype, name, descriptor)
				}
			}
		})

		// Copy static properties and methods
		Object.getOwnPropertyNames(mixinClass).forEach(name => {
			// Avoid overwriting standard static properties
			if (!['length', 'name', 'prototype'].includes(name)) {
				const descriptor = Object.getOwnPropertyDescriptor(mixinClass, name)
				if (descriptor) {
					Object.defineProperty(targetClass, name, descriptor)
				}
			}
		})
	})
}
