/**
 * @fileoverview Manages the interning of strings to save memory and enable fast comparisons.
 *
 * This manager stores each unique string only once and provides a lightweight
 * numeric reference (a "Ref" or ID) to it. Components store this Ref instead of
 * the full string. This is highly effective for strings that are frequently
 * repeated, such as asset names, prefab IDs, or UI labels.
 *
 * ---
 * # Developer Note: Working with StringManager
 * ---
 *
 * ## 1. Overview
 *
 * The `StringManager` is a critical engine utility designed for memory optimization
 * and performance. It achieves this through **string interning**: storing each
 * unique string value only once and providing a lightweight numeric reference (`ref`) to it.
 *
 * Systems and components should store these `ref`s instead of raw strings,
 * especially for values that are frequently repeated (e.g., asset paths, entity
 * tags, UI text).
 *
 * **Benefits:**
 * - **Memory Savings:** Reduces memory footprint by eliminating duplicate strings.
 * - **Performance:** Comparing two `ref`s (an integer comparison) is significantly
 *   faster than comparing two strings.
 *
 * ## 2. How to Use `StringManager`
 *
 * There are two primary ways to interact with the `StringManager`, each with its
 * own trade-offs.
 *
 * ### Method 1: Safe API (`.get()`)
 * This is the simplest and safest method for retrieving a string.
 * ```javascript
 * const nameRef = someComponent.nameRef; // e.g., 123
 * const characterName = stringManager.get(nameRef); // Returns 'Gandalf'
 * ```
 * - **Pros:** Simple, clear, and safe.
 * - **Cons:** Incurs function call overhead.
 * - **When to use:** Ideal for non-performance-critical code, such as
 *   initialization, one-off lookups, or debugging.
 *
 * ### Method 2: High-Performance Direct Access (`.storage`)
 * For performance-critical systems that operate in tight loops (e.g., rendering,
 * physics), direct access to the underlying storage array is preferred to avoid
 * per-entity method call overhead.
 * ```javascript
 * // Inside a high-frequency system update
 * const storage = stringManager.storage; // Cache the array reference once per update
 *
 * for (const entity of entities) {
 *     const nameRef = entity.nameComponent.ref;
 *     const entityName = storage[nameRef]; // Blazing fast lookup
 *     // ... use entityName for rendering, etc.
 * }
 * ```
 * - **Pros:** Maximum performance by avoiding function call overhead.
 * - **Cons:** Bypasses API safeguards. Requires developer discipline.
 * - **When to use:** Inside the main loop of any high-performance system.
 *
 * ## 3. The Golden Rule of Direct Access
 *
 * When using `stringManager.storage`, you must adhere to one critical rule:
 *
 * > **Treat `stringManager.storage` as a READ-ONLY array.**
 *
 * Only the `stringManager.intern()` method should ever write to this array.
 * Writing to it from any other system will corrupt the manager's internal state
 * and lead to unpredictable, hard-to-debug issues.
 *
 * ## 4. Working with Strings: Immutability & Updates
 *
 * ### Understanding String Immutability
 * A core concept of JavaScript is that **strings are immutable**. This means they
 * cannot be changed in place. Any operation that appears to "modify" a string
 * actually creates a **new string** in memory.
 *
 * ### The Correct Pattern for "Updating" a Shared String
 * If you need to make a persistent change to a string that all systems can see
 * (e.g., a player renames their character), follow this pattern:
 *
 * 1.  **Create the new string value locally.**
 * 2.  **Intern the new string** to get a new `ref`.
 * 3.  **Update the component** to store the new `ref`.
 *
 * ## 5. Pitfalls & Dangers
 *
 * **The Cardinal Sin: Never write directly to the storage array.**
 *
 * The `storage` property is exposed for performance, trusting the developer to use
 * it responsibly.
 *
 */
export class StringManager {
	constructor() {
		/**
		 * @private
		 * @type {Map<string, number>}
		 */
		this.stringToRef = new Map([['', 0]])
		/**
		 * @private
		 * @type {string[]}
		 */
		this.refToString = ['']
		/**
		 * @private
		 * @type {number}
		 */
		this.nextRef = 1

		/**
		 * Direct, public access to the internal storage array for high-performance systems.
		 * This maps a reference ID (number) to its string value. Systems should cache this
		 * reference at the start of their update loop to avoid method call overhead.
		 * @type {string[]}
		 */
		this.storage = this.refToString
	}

	intern(str) {
		if (this.stringToRef.has(str)) {
			return this.stringToRef.get(str)
		}
		const ref = this.nextRef++
		this.stringToRef.set(str, ref)
		this.refToString[ref] = str
		return ref
	}

	get(ref) {
		return this.refToString[ref]
	}
}
