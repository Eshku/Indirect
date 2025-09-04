import { RawCommandBuffer } from './RawCommandBuffer.js';
import { SortableCommandBuffer, SortKeyLayout, SortPhase } from './SortableCommandBuffer.js';
import { OpCodes } from './CommandOpcodes.js';

/**
 * @fileoverview A high-level API for recording commands into a low-level byte buffer.
 * This is the primary interface systems should use for deferred structural changes.
 * It combines a RawCommandBuffer for data and a SortableCommandBuffer for execution order.
 */
export class CommandBuffer {
    /**
     * @param {import('../ComponentManager/ComponentManager.js').ComponentManager} componentManager
     * @param {import('../PrefabManager/PrefabManager.js').PrefabManager} prefabManager
     */
    constructor(componentManager, prefabManager) {
        this.rawBuffer = new RawCommandBuffer(componentManager);
        this.sortableBuffer = new SortableCommandBuffer();
        this.componentManager = componentManager;
        this.prefabManager = prefabManager;
    }

    /**
     * Clears the buffers for the next frame. Called by the SystemManager after a flush.
     */
    clear() {
        this.rawBuffer.reset();
        this.sortableBuffer.clear();
    }

    /**
     * Records a command to add a component to an entity.
     * @param {number} entityId
     * @param {number} componentTypeID
     * @param {object} data
     * @param {number} [layer=0] - Execution layer for fine-grained ordering.
     */
    addComponent(entityId, componentTypeID, data = {}, layer = 0) {
        const offset = this.rawBuffer.offset;
        const startOffset = offset;

        // Write OpCode and Payload
        this.rawBuffer.writeU8(OpCodes.ADD_COMPONENT);
        this.rawBuffer.writeU32(entityId);
        this.rawBuffer.writeU16(componentTypeID);
        this.rawBuffer.writeComponentData(componentTypeID, data);

        // Calculate length and write sort key
        const length = this.rawBuffer.offset - startOffset;
        const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, entityId, 0);
        this.sortableBuffer.add(key, offset, length);
    }

    /**
     * Records a command to set a component's data on an entity.
     * Assumes the component already exists. For performance, this is not checked here.
     * @param {number} entityId
     * @param {number} componentTypeID
     * @param {object} data
     * @param {number} [layer=0]
     */
    setComponentData(entityId, componentTypeID, data, layer = 0) {
        const offset = this.rawBuffer.offset;
        const startOffset = offset;

        this.rawBuffer.writeU8(OpCodes.SET_COMPONENT_DATA);
        this.rawBuffer.writeU32(entityId);
        this.rawBuffer.writeU16(componentTypeID);
        this.rawBuffer.writeComponentData(componentTypeID, data);

        const length = this.rawBuffer.offset - startOffset;
        const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, entityId, 2); // Secondary ID to sort after add/remove
        this.sortableBuffer.add(key, offset, length);
    }

    /**
     * Records a command to remove a component from an entity.
     * @param {number} entityId
     * @param {number} componentTypeID
     * @param {number} [layer=0]
     */
    removeComponent(entityId, componentTypeID, layer = 0) {
        const offset = this.rawBuffer.offset;
        const startOffset = offset;

        this.rawBuffer.writeU8(OpCodes.REMOVE_COMPONENT);
        this.rawBuffer.writeU32(entityId);
        this.rawBuffer.writeU16(componentTypeID);

        const length = this.rawBuffer.offset - startOffset;
        const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, entityId, 1); // Use secondary ID to sort removes after adds
        this.sortableBuffer.add(key, offset, length);
    }

    /**
     * Records a command to destroy an entity.
     * @param {number} entityId
     * @param {number} [layer=0]
     */
    destroyEntity(entityId, layer = 0) {
        const offset = this.rawBuffer.offset;
        const startOffset = offset;

        this.rawBuffer.writeU8(OpCodes.DESTROY_ENTITY);
        this.rawBuffer.writeU32(entityId);

        const length = this.rawBuffer.offset - startOffset;
        const key = SortableCommandBuffer.encodeKey(SortPhase.DESTROY, layer, entityId, 0);
        this.sortableBuffer.add(key, offset, length);
    }

    /**
     * Records a command to create a new entity.
     * @param {Map<number, object>} componentIdMap
     * @param {number} [layer=0]
     */
    createEntity(componentIdMap, layer = 0) {
        const offset = this.rawBuffer.offset;
        const startOffset = offset;

        this.rawBuffer.writeU8(OpCodes.CREATE_ENTITY);
        this.rawBuffer.writeComponentIdMap(componentIdMap);

        const length = this.rawBuffer.offset - startOffset;
        // For creation, primary/secondary IDs are less important, but could be used for batching.
        const key = SortableCommandBuffer.encodeKey(SortPhase.CREATE, layer, 0, 0);
        this.sortableBuffer.add(key, offset, length);
    }

    /**
     * Records a command to instantiate a prefab with optional overrides.
     * @param {string} prefabName The name of the prefab to instantiate.
     * @param {Map<number, object>} [overrides=new Map()] A map of componentTypeID to data objects that override the prefab's defaults.
     * @param {number} [layer=0]
     */
    instantiate(prefabName, overrides = new Map(), layer = 0) {
        const numericId = this.prefabManager.getPrefabNumericId(prefabName);
        if (numericId === undefined) {
            console.error(`[CommandBuffer] Could not instantiate prefab. Name '${prefabName}' not found in PrefabManager.`);
            return;
        }

        const offset = this.rawBuffer.offset;
        const startOffset = offset;

        this.rawBuffer.writeU8(OpCodes.INSTANTIATE_PREFAB);
        this.rawBuffer.writeU16(numericId); // Write numeric ID instead of string
        this.rawBuffer.writeComponentIdMap(overrides);

        const length = this.rawBuffer.offset - startOffset;
        const key = SortableCommandBuffer.encodeKey(SortPhase.CREATE, layer, 0, 3); // Another secondary ID
        this.sortableBuffer.add(key, offset, length);
    }

    /**
     * Records a command to create a new entity in a known archetype.
     * This is an optimized path that avoids archetype lookup during execution.
     * @param {number} archetypeId The ID of the archetype to create the entity in.
     * @param {Map<number, object>} componentIdMap The component data for the new entity.
     * @param {number} [layer=0]
     */
    createEntityInArchetype(archetypeId, componentIdMap, layer = 0) {
        const offset = this.rawBuffer.offset;
        const startOffset = offset;

        this.rawBuffer.writeU8(OpCodes.CREATE_ENTITY_IN_ARCHETYPE);
        this.rawBuffer.writeU16(archetypeId); // Archetype ID is known
        this.rawBuffer.writeComponentIdMap(componentIdMap);

        const length = this.rawBuffer.offset - startOffset;
        const key = SortableCommandBuffer.encodeKey(SortPhase.CREATE, layer, 0, 2); // Secondary ID to distinguish
        this.sortableBuffer.add(key, offset, length);
    }

    /**
     * Records a command to create a batch of identical entities.
     * @param {Map<number, object>} componentIdMap The components to add to each entity.
     * @param {number} count The number of entities to create.
     * @param {number} [layer=0]
     */
    createEntities(componentIdMap, count, layer = 0) {
        const offset = this.rawBuffer.offset;
        const startOffset = offset;

        this.rawBuffer.writeU8(OpCodes.CREATE_ENTITIES_IDENTICAL);
        this.rawBuffer.writeU32(count);
        this.rawBuffer.writeComponentIdMap(componentIdMap);

        const length = this.rawBuffer.offset - startOffset;
        const key = SortableCommandBuffer.encodeKey(SortPhase.CREATE, layer, 0, 1); // Secondary ID to distinguish from single create
        this.sortableBuffer.add(key, offset, length);
    }

    /**
     * A high-level helper that queues a destroy command for every entity matching a query.
     * @param {import('../QueryManager/Query.js').Query} query The query to iterate.
     * @param {number} [layer=0]
     */
    destroyEntitiesInQuery(query, layer = 0) {
        for (const chunk of query.iter()) {
            for (let i = 0; i < chunk.size; i++) {
                this.destroyEntity(chunk.entities[i], layer);
            }
        }
    }

    /**
     * A high-level helper that adds a component to every entity matching a query.
     * @param {import('../QueryManager/Query.js').Query} query
     * @param {number} componentTypeID
     * @param {object} [data={}]
     * @param {number} [layer=0]
     */
    addComponentToQuery(query, componentTypeID, data = {}, layer = 0) {
        for (const chunk of query.iter()) {
            for (let i = 0; i < chunk.size; i++) {
                this.addComponent(chunk.entities[i], componentTypeID, data, layer);
            }
        }
    }

    /**
     * A high-level helper that removes a component from every entity matching a query.
     * @param {import('../QueryManager/Query.js').Query} query
     * @param {number} componentTypeID
     * @param {number} [layer=0]
     */
    removeComponentFromQuery(query, componentTypeID, layer = 0) {
        for (const chunk of query.iter()) {
            for (let i = 0; i < chunk.size; i++) {
                this.removeComponent(chunk.entities[i], componentTypeID, layer);
            }
        }
    }

    /**
     * A high-level helper that sets component data for every entity matching a query.
     * This is an efficient way to apply in-place data changes to a group of entities.
     * @param {import('../QueryManager/Query.js').Query} query
     * @param {number} componentTypeID
     * @param {object} data
     * @param {number} [layer=0]
     */
    setComponentDataOnQuery(query, componentTypeID, data, layer = 0) {
        for (const chunk of query.iter()) {
            for (let i = 0; i < chunk.size; i++) {
                this.setComponentData(chunk.entities[i], componentTypeID, data, layer);
            }
        }
    }

    /**
     * Prepares the command buffer for execution by sorting the commands.
     * @returns {{sortedOffsets: Uint32Array, sortedLengths: Uint32Array}}
     */
    getSortedCommands() {
        this.sortableBuffer.sort();
        return {
            sortedOffsets: this.sortableBuffer.getSortedOffsets(),
            sortedLengths: this.sortableBuffer.getSortedLengths(),
        };
    }

    // --- Future Work Note ---
    // The current API supports batch creation of identical entities. Future enhancements could include:
    // - `createEntitiesWithData(archetypeId, dataArray)`: Creates a batch of entities in the same archetype
    //   but with varied initial component data for each. This would correspond to `OpCodes.CREATE_ENTITIES_VARIED`.
    // - `instantiateBatch(prefabName, count, overrides)`: A highly optimized path for instantiating many
    //   copies of the same prefab, potentially with some shared overrides.
}