export const OpCodes = Object.freeze({
	// --- Raw Sortable Commands (Recorded) ---

	// --- Structural Changes (Phase: MODIFY) ---
	ADD_COMPONENT: 11,
	ADD_COMPONENTS: 12, // New command for adding multiple components from a payload
	REMOVE_COMPONENT: 13,
	REMOVE_COMPONENTS: 14, // New command for removing multiple components
	// bulk commands
	BULK_ADD_COMPONENTS: 15,
	BULK_REMOVE_COMPONENTS: 16,
	DESTROY_ENTITY: 17,

		// Silent structural changes
	ADD_COMPONENT_SILENT: 18,
	ADD_COMPONENTS_SILENT: 19,

	// --- Data-Only Changes (Phase: MODIFY) ---
	SET_COMPONENTS: 21,
	SET_COMPONENTS_SILENT: 22, // for silent SoA updates
	SET_ENTITIES: 23, // for bulk-resetting pooled entities

	// --- Creation (Phase: CREATE) ---
	INSTANTIATE: 31,
	INSTANTIATE_SILENT: 32,

	// --- Bulk Immediate Commands ---
	// These are special-case commands that are written directly to the compiled stream and bypass the main sort/compile pipeline.
	DESTROY_ENTITIES_IN_CHUNK: 40,
	DESTROY_BY_QUERY: 41,
})
