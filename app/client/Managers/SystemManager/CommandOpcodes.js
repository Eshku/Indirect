/**
 * @fileoverview Defines numeric operation codes for all commands used in the CommandBuffer.
 * Using fixed numeric codes instead of strings is a core part of the raw data buffer optimization.
 */

export const OpCodes = Object.freeze({
	// Entity Lifecycle
	CREATE_ENTITY: 1,
	DESTROY_ENTITY: 2,
	INSTANTIATE_PREFAB: 3,
	CREATE_ENTITY_IN_ARCHETYPE: 4,

	// Component Modifications (Per-Entity)
	ADD_COMPONENT: 10,
	REMOVE_COMPONENT: 11,
	SET_COMPONENT_DATA: 12, // For when the component is known to exist

	// Batch Creation
	CREATE_ENTITIES_IDENTICAL: 20, // createIdenticalEntitiesInArchetype
	CREATE_ENTITIES_VARIED: 21, // createEntitiesInArchetype
	INSTANTIATE_PREFAB_BATCH: 22,

	// Query-Based Modifications (Future Work - currently handled by CommandBuffer helpers)
	ADD_COMPONENT_TO_QUERY: 30,
	REMOVE_COMPONENT_FROM_QUERY: 31,
	SET_COMPONENT_DATA_ON_QUERY: 32,
	DESTROY_ENTITIES_IN_QUERY: 33,
})
