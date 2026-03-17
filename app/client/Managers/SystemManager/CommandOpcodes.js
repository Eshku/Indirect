/**
 * Defines numeric operation codes for all commands used in the CommandBuffer.
 * Using fixed numeric codes instead of strings is a core part of the raw data buffer optimization.
 */

export const OpCodes = Object.freeze({
	// Entity Lifecycle
	CREATE_ENTITY: 1,
	DESTROY_ENTITY: 2,
	DESTROY_ENTITIES_IN_CHUNK: 3,

	// Component Modifications
	ADD_COMPONENT: 10,
	REMOVE_COMPONENT: 11,
	SET_COMPONENT_DATA: 12,
	ADD_COMPONENTS: 13, // Add multiple components to an entity
	SET_COMPONENT_DATA_SILENT: 14, // Set single component data without marking dirty
	SET_COMPONENTS_DATA: 15, // Set multiple components data
	SET_COMPONENTS_DATA_SILENT: 16, // Set multiple components data silently
	SET_COMPONENT_ENABLED: 17, // Enable/disable a single component
	MARK_DIRTY: 18, // Mark a single component as dirty

	// Batch Creation
	CREATE_ENTITIES_IDENTICAL: 20,
})
