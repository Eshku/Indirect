//! Legacy, was used during planck.js testing, going to keep it incase I decide to go back to it.

const INITIAL_CATEGORIES = {
	NONE: 0,
	PLAYER: 1 << 0,
	ENEMY: 1 << 1,
	GROUND: 1 << 2, // Static ground, walls
	ITEM: 1 << 3, // Pickups, interactables
	PLAYER_PROJECTILE: 1 << 4,
	ENEMY_PROJECTILE: 1 << 5,
	TRIGGER: 1 << 6, // For non-colliding trigger volumes
}

/**
 * Defines the default `filterMaskBits` for each category.
 * The key is the category name (must exist in INITIAL_CATEGORIES).
 * The value is a bitmask indicating which other categories fixtures of this type will interact with by default.
 */
const INITIAL_MASKS = {
	NONE: INITIAL_CATEGORIES.NONE, // A NONE category fixture interacts with nothing.
	PLAYER:
		INITIAL_CATEGORIES.GROUND |
		INITIAL_CATEGORIES.ITEM |
		INITIAL_CATEGORIES.ENEMY_PROJECTILE |
		INITIAL_CATEGORIES.ENEMY |
		INITIAL_CATEGORIES.TRIGGER,
	// Enemies do NOT collide with other ENEMY fixtures ---
	ENEMY:
		INITIAL_CATEGORIES.GROUND |
		INITIAL_CATEGORIES.ITEM |
		INITIAL_CATEGORIES.PLAYER_PROJECTILE |
		INITIAL_CATEGORIES.PLAYER |
		INITIAL_CATEGORIES.TRIGGER,
	GROUND:
		INITIAL_CATEGORIES.PLAYER |
		INITIAL_CATEGORIES.ENEMY |
		INITIAL_CATEGORIES.PLAYER_PROJECTILE |
		INITIAL_CATEGORIES.ENEMY_PROJECTILE,
	ITEM: INITIAL_CATEGORIES.PLAYER | INITIAL_CATEGORIES.ENEMY | INITIAL_CATEGORIES.TRIGGER,
	PLAYER_PROJECTILE: INITIAL_CATEGORIES.GROUND | INITIAL_CATEGORIES.ENEMY,
	ENEMY_PROJECTILE: INITIAL_CATEGORIES.GROUND | INITIAL_CATEGORIES.PLAYER,
	TRIGGER: INITIAL_CATEGORIES.PLAYER | INITIAL_CATEGORIES.ENEMY | INITIAL_CATEGORIES.ITEM,
}

/**
 * Manages the Planck.js physics world, including simulation, collision categories, and body creation.
 * It provides a centralized system for defining and managing how different types of game objects interact physically.
 * @property {planck.World | null} world - The main Planck.js world instance.
 * @property {Record<string, number>} categories - A map of category names to their bitmask values (e.g., 'PLAYER': 1).
 * @property {Record<string, number>} masks - A map of category names to their default collision mask bits.
 * @property {Map<string, {category: number, mask: number}>} filters - Caches registered collision filter definitions by name.
 */
export class PhysicsManager {
	constructor() {
		this.world = null
		this.categories = { ...INITIAL_CATEGORIES } // Instance copy
		this.masks = { ...INITIAL_MASKS } // Instance copy
		this.surfaceCategories = new Set()
		this.filters = new Map()
		this.PIXELS_PER_METER = 50 // The scale factor between physics (meters) and rendering (pixels).
	}

	async init() {
		const { World, Vec2 } = planck
		this.world = new World({ gravity: Vec2(0, 10) }) // Positive Y for gravity if Y is downwards in rendering

		this.registerDefaults()
		this.surfaceCategories.add(this.categories.GROUND)

		// Optional: Inform planck.js about our rendering scale.
		// This can help it tune some internal values.
		planck.Settings.lengthUnitsPerMeter = this.PIXELS_PER_METER
	}

	/**
	 * Registers the default collision filters.
	 * @private
	 */
	registerDefaults() {
		for (const [categoryName, defaultMask] of Object.entries(this.masks)) {
			const categoryBit = this.categories[categoryName]
			if (categoryBit !== undefined) {
				this.registerFilter(categoryName, categoryBit, defaultMask)
			} else {
				// This case should ideally not happen if CATEGORIES and MASKS are well-defined.
				console.error(
					`PhysicsManager: Category name "${categoryName}" from this.masks not found in this.categories. Skipping registration.`
				)
			}
		}
	}

	/**
	 * Registers a named collision filter, including its category bits and default mask bits.
	 * If a filter with the same name already exists, it will be overwritten if allowOverwrite is true.
	 * @param {string} filterName - The desired name for the collision filter (e.g., 'PLAYER').
	 * @param {number} categoryBits - The category bitmask for this filter (e.g., 1 << 0).
	 * @param {number} maskBits - The default mask bits for this filter (what it collides with).
	 * @param {boolean} [allowOverwrite=false] - Whether to allow overwriting an existing filter.
	 * @returns {boolean} True if registration was successful, false otherwise (e.g., name conflict, invalid input).
	 */
	registerFilter(filterName, categoryBits, maskBits, allowOverwrite = false) {
		if (typeof filterName !== 'string' || filterName.trim() === '') {
			console.error('PhysicsManager.registerFilter: Filter name must be a non-empty string.')
			return false
		}
		if (typeof categoryBits !== 'number') {
			console.error(`PhysicsManager.registerFilter: Category for filter "${filterName}" must be a number.`)
			return false
		}
		if (typeof maskBits !== 'number') {
			console.error(`PhysicsManager.registerFilter: Mask for filter "${filterName}" must be a number.`)
			return false
		}

		if (this.filters.has(filterName) && !allowOverwrite) {
			const existing = this.filters.get(filterName)
			console.warn(
				`PhysicsManager.registerFilter: Filter "${filterName}" is already registered. Existing: C:${existing.category}, M:${existing.mask}. New (C:${categoryBits}, M:${maskBits}) ignored.`
			)
			return false
		} else if (this.filters.has(filterName) && allowOverwrite) {
			// console.log(`PhysicsManager.registerFilter: Overwriting filter "${filterName}".`);
		}

		this.filters.set(filterName, { category: categoryBits, mask: maskBits })
		// console.log(`PhysicsManager: Collision filter "${filterName}" registered with C:${categoryBits}, M:${maskBits}.`);
		return true
	}

	/**
	 * Retrieves the full collision filter (category and mask) for a registered name.
	 * @param {string} filterName - The name of the collision filter.
	 * @returns {{category: number, mask: number}} The collision filter. Returns 'NONE' filter if not found.
	 */
	getFilter(filterName) {
		if (!this.filters.has(filterName)) {
			console.warn(`PhysicsManager.getFilter: Filter "${filterName}" not found. Returning 'NONE' filter.`)
			// Ensure 'NONE' is always registered and available as a fallback.
			// registerDefaults should handle registering 'NONE'.
			const noneFilter = this.filters.get('NONE')
			return noneFilter || { category: this.categories.NONE, mask: this.masks.NONE } // Absolute fallback
		}
		return this.filters.get(filterName)
	}

	/**
	 * Retrieves the category bits for a registered collision filter name.
	 * @param {string} filterName - The name of the collision filter.
	 * @returns {number} The category bits. Returns this.categories.NONE if the filter is not found.
	 */
	getCategory(filterName) {
		return this.getFilter(filterName).category
	}

	/**
	 * Retrieves the default mask bits for a registered collision filter name.
	 * @param {string} filterName - The name of the collision filter.
	 * @returns {number} The mask bits. Returns this.masks.NONE if the filter is not found.
	 */
	getMask(filterName) {
		return this.getFilter(filterName).mask
	}

	/**
	 * Adds a new collision category and its default mask.
	 * This also registers a filter definition for it.
	 * @param {string} name - The name for the new category (e.g., 'POWERUP').
	 * @param {number} bitValue - The bit value for this category (must be a power of 2).
	 * @param {number} defaultMaskValue - The default mask bits for this new category.
	 * @returns {boolean} True if the category was added successfully, false otherwise.
	 */
	addCategory(name, bitValue, defaultMaskValue) {
		if (typeof name !== 'string' || name.trim() === '') {
			console.error('PhysicsManager.addCategory: Category name must be a non-empty string.')
			return false
		}
		if (typeof bitValue !== 'number' || (bitValue !== 0 && (bitValue & (bitValue - 1)) !== 0)) {
			console.error('PhysicsManager.addCategory: Category bit value must be a power of 2 (e.g., 1, 2, 4, 8...).')
			return false
		}
		if (this.categories[name] !== undefined) {
			console.error(
				`PhysicsManager.addCategory: Category "${name}" already exists with bit value ${this.categories[name]}. Use updateDefaultMask to change its mask.`
			)
			return false
		}
		for (const existingName in this.categories) {
			if (this.categories[existingName] === bitValue && bitValue !== 0) {
				console.error(
					`PhysicsManager.addCategory: Bit value ${bitValue} is already used by category "${existingName}".`
				)
				return false
			}
		}
		if (typeof defaultMaskValue !== 'number') {
			console.error('PhysicsManager.addCategory: Default mask value must be a number.')
			return false
		}

		this.categories[name] = bitValue
		this.masks[name] = defaultMaskValue

		this.registerFilter(name, bitValue, defaultMaskValue, true) // Allow overwrite, though it should be new
		console.log(
			`PhysicsManager: Category "${name}" added (Bit: ${bitValue}, Default Mask: ${defaultMaskValue}). Filter registered.`
		)
		return true
	}

	/**
	 * Updates the default mask for an existing category.
	 * This also updates the mask in its registered filter definition.
	 * @param {string} categoryName - The name of the category to update.
	 * @param {number} newMaskBits - The new default mask bits.
	 * @returns {boolean} True if the mask was updated successfully, false otherwise.
	 */
	updateDefaultMask(categoryName, newMaskBits) {
		if (this.categories[categoryName] === undefined) {
			console.error(
				`PhysicsManager.updateDefaultMask: Category "${categoryName}" does not exist. Use addCategory to add it first.`
			)
			return false
		}
		if (typeof newMaskBits !== 'number') {
			console.error('PhysicsManager.updateDefaultMask: New mask bits must be a number.')
			return false
		}

		this.masks[categoryName] = newMaskBits
		// Re-register the filter with the new mask, allowing overwrite.
		this.registerFilter(categoryName, this.categories[categoryName], newMaskBits, true)
		console.log(
			`PhysicsManager: Default mask for category "${categoryName}" updated to ${newMaskBits}. Filter updated.`
		)
		return true
	}

	/** Retrieves the bit value for a category by its name. */
	getCategoryBit(name) {
		return this.categories[name]
	}

	/** Returns a shallow copy of all registered categories. */
	getAllCategories() {
		return { ...this.categories }
	}

	/** Returns a shallow copy of all registered default masks. */
	getAllMasks() {
		return { ...this.masks }
	}

	/**
	 * @returns {planck.World | null} The Planck.js world instance.
	 */
	getWorld() {
		return this.world
	}

	/**
	 * @returns {number} The scale factor for converting meters to pixels.
	 */
	getPixelsPerMeter() {
		return this.PIXELS_PER_METER
	}
}

export const physicsManager = new PhysicsManager()
