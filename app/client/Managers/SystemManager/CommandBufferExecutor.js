import { OpCodes } from './CommandOpcodes.js';
import { CommandBufferReader } from './CommandBufferReader.js';

/**
 * @fileoverview Executes commands from the CommandBuffer in an optimized, batched manner.
 * This class contains the core logic for processing deferred structural changes.
 */

/**
 * --- ARCHITECTURAL NOTE on the Executor's Performance ---
 *
 * This executor is designed for maximum performance by avoiding a naive, one-by-one execution model.
 * Its efficiency comes from a two-pass approach that leverages the pre-sorted, binary command buffer:
 *
 * 1.  **Consolidation Pass (`_consolidate`)**:
 *     - The executor makes a single, high-speed pass over the entire command buffer.
 *     - It reads the commands but does **not** apply them immediately. Instead, it builds up a "net effect"
 *       for the frame. For example, if a command adds a component to an entity and a later command
 *       destroys that same entity, the consolidation pass intelligently discards the `addComponent`
 *       operation, saving work.
 *
 * 2.  **Batched Execution (`_flush...` methods)**:
 *     - After consolidating, the executor applies the changes in large, optimized batches.
 *     - **Archetype Moves**: Instead of moving entities one at a time, it groups all entities that are
 *       moving between the same source and target archetypes and moves them together via
 *       `archetypeManager.moveEntitiesInBatch()`. This is vastly more cache-friendly.
 *     - **Creations & Deletions**: All creations for a given archetype are batched together, and all
 *       deletions are processed in a single call.
 *
 * This "consolidate then batch" pattern is significantly faster than executing commands as they are
 * read, as it minimizes redundant operations and maximizes cache coherency during the actual
 * mutation of the world state.
 */

/**
 * A reusable object for tracking the net modifications for a single entity.
 * @private
 */
class Modification {
	constructor() {
		this.additions = new Map(); // componentTypeID -> data
		this.removals = new Set();  // componentTypeID
	}
	reset() {
		this.additions.clear();
		this.removals.clear();
	}
}

/**
 * Processes the command buffer, applying all queued structural changes to the world state.
 */
export class CommandBufferExecutor {
	/**
	 * @param {import('../EntityManager/EntityManager.js').EntityManager} entityManager
	 * @param {import('../ComponentManager/ComponentManager.js').ComponentManager} componentManager
	 * @param {import('../ArchetypeManager/ArchetypeManager.js').ArchetypeManager} archetypeManager
	 * @param {import('./SystemManager.js').SystemManager} systemManager
	 * @param {import('../PrefabManager/PrefabManager.js').PrefabManager} prefabManager
	 */
	constructor(entityManager, componentManager, archetypeManager, systemManager, prefabManager) {
		this.entityManager = entityManager;
		this.componentManager = componentManager;
		this.archetypeManager = archetypeManager;
		this.systemManager = systemManager;
		this.prefabManager = prefabManager;

		// Reusable state for the execute method to minimize GC pressure
		this._deletions = new Set();
		this._moves = new Map(); // Map<sourceArchetypeId, Map<targetArchetypeId, MoveData>>
		this._creations = new Map(); // Map<archetypeId, Array<componentDataMap>>
		this._identicalCreations = new Map(); // Map<archetypeId, Array<{map, count}>>
		this._inPlaceUpdates = new Map(); // Map<archetypeId, Array<{entityId, updates}>>
		this._modifications = new Map(); // Map<entityId, Modification>

		this._modificationPool = [];
		this._modificationPoolIndex = 0;
	}

	/**
	 * Executes all commands queued in the provided CommandBuffer.
	 * @param {import('./CommandBuffer.js').CommandBuffer} commandBuffer
	 */
	execute(commandBuffer) {
		const { sortedOffsets } = commandBuffer.getSortedCommands();
		if (sortedOffsets.length === 0) return;

		const reader = new CommandBufferReader(commandBuffer.rawBuffer, this.componentManager);

		// 1. Consolidation Phase: Read the command stream and populate batch operations.
		this._consolidate(reader, sortedOffsets);

		// 2. Execution Phase: Apply batched operations in the correct order.
		this._flushDeletions();
		this._flushModifications();
		this._flushCreations();

		// 3. Cleanup
		commandBuffer.clear();
	}

	/**
	 * Reads the sorted command stream and populates the internal batching data structures.
	 * @param {CommandBufferReader} reader
	 * @param {Uint32Array} sortedOffsets
	 * @private
	 */
	_consolidate(reader, sortedOffsets) {
		this._deletions.clear();
		this._moves.clear();
		this._creations.clear();
		this._identicalCreations.clear();
		this._inPlaceUpdates.clear();
		this._modifications.clear();
		this._resetModPool();

		for (let i = 0; i < sortedOffsets.length; i++) {
			reader.seek(sortedOffsets[i]);
			const opCode = reader.readU8();

			switch (opCode) {
				case OpCodes.CREATE_ENTITY: {
					const componentIdMap = reader.readComponentIdMap();
					const archetypeMask = this.archetypeManager.generateArchetypeMask(componentIdMap.keys());
					const archetypeId = this.archetypeManager.getArchetypeByMask(archetypeMask);

					if (!this._creations.has(archetypeId)) {
						this._creations.set(archetypeId, []);
					}
					this._creations.get(archetypeId).push(componentIdMap);
					break;
				}

				case OpCodes.CREATE_ENTITY_IN_ARCHETYPE: {
					const archetypeId = reader.readU16();
					const componentIdMap = reader.readComponentIdMap();

					if (!this._creations.has(archetypeId)) {
						this._creations.set(archetypeId, []);
					}
					this._creations.get(archetypeId).push(componentIdMap);
					break;
				}

				case OpCodes.INSTANTIATE_PREFAB: {
					const numericId = reader.readU16();
					const overrides = reader.readComponentIdMap(); // This is typeID -> data

					// Use the new, faster lookup method
					const prefabData = this.prefabManager.getPrefabDataByNumericId(numericId);
					if (!prefabData) {
						// Log the numeric ID for easier debugging if a prefab fails to load/register
						console.error(`[CommandBufferExecutor] Prefab with ID '${numericId}' not found or preloaded during instantiation.`);
						continue;
					}

					// Convert prefab's name-keyed components to a typeID-keyed map
					const baseComponents = new Map();
					if (prefabData.components) {
						for (const componentName in prefabData.components) {
							const typeID = this.componentManager.getComponentTypeIDByName(componentName);
							if (typeID !== undefined) {
								baseComponents.set(typeID, prefabData.components[componentName]);
							}
						}
					}

					// Merge overrides. Overrides take precedence.
					const finalComponents = new Map([...baseComponents, ...overrides]);

					// Now, this is the same as CREATE_ENTITY
					const archetypeMask = this.archetypeManager.generateArchetypeMask(finalComponents.keys());
					const archetypeId = this.archetypeManager.getArchetypeByMask(archetypeMask);

					if (!this._creations.has(archetypeId)) this._creations.set(archetypeId, []);
					this._creations.get(archetypeId).push(finalComponents);
					break;
				}

				case OpCodes.CREATE_ENTITIES_IDENTICAL: {
					const count = reader.readU32();
					const componentIdMap = reader.readComponentIdMap();
					const archetypeMask = this.archetypeManager.generateArchetypeMask(componentIdMap.keys());
					const archetypeId = this.archetypeManager.getArchetypeByMask(archetypeMask);

					if (!this._identicalCreations.has(archetypeId)) {
						this._identicalCreations.set(archetypeId, []);
					}
					this._identicalCreations.get(archetypeId).push({ map: componentIdMap, count: count });
					break;
				}

				case OpCodes.DESTROY_ENTITY: {
					const entityId = reader.readU32();
					this._deletions.add(entityId);
					this._modifications.delete(entityId);
					break;
				}

				case OpCodes.ADD_COMPONENT:
				case OpCodes.SET_COMPONENT_DATA: {
					const entityId = reader.readU32();
					if (this._deletions.has(entityId)) continue;

					const componentTypeID = reader.readU16();
					const data = reader.readComponentData(componentTypeID);

					let mod = this._modifications.get(entityId);
					if (!mod) {
						mod = this._getModObject();
						this._modifications.set(entityId, mod);
					}

					mod.additions.set(componentTypeID, data);
					mod.removals.delete(componentTypeID);
					break;
				}

				case OpCodes.REMOVE_COMPONENT: {
					const entityId = reader.readU32();
					if (this._deletions.has(entityId)) continue;

					const componentTypeID = reader.readU16();

					let mod = this._modifications.get(entityId);
					if (!mod) {
						mod = this._getModObject();
						this._modifications.set(entityId, mod);
					}

					mod.removals.add(componentTypeID);
					mod.additions.delete(componentTypeID);
					break;
				}
			}
		}
	}

	/**
	 * Calculates the final archetype moves and in-place data updates and executes them.
	 * @private
	 */
	_flushModifications() {
		const moves = this._moves;
		const inPlaceUpdates = this._inPlaceUpdates;
		const componentBitFlags = this.componentManager.componentBitFlags;

		for (const [entityId, mod] of this._modifications.entries()) {
			const sourceArchetypeId = this.entityManager.getArchetypeForEntity(entityId);
			if (sourceArchetypeId === undefined) continue;

			let addMask = 0n
			for (const typeId of mod.additions.keys()) {
				if (!this.archetypeManager.hasComponentType(sourceArchetypeId, typeId)) addMask |= componentBitFlags[typeId];
			}

			let removeMask = 0n
			for (const typeId of mod.removals) {
				if (this.archetypeManager.hasComponentType(sourceArchetypeId, typeId)) removeMask |= componentBitFlags[typeId];
			}

			if (addMask === 0n && removeMask === 0n) {
				if (mod.additions.size > 0) {
					if (!inPlaceUpdates.has(sourceArchetypeId)) inPlaceUpdates.set(sourceArchetypeId, []);
					inPlaceUpdates.get(sourceArchetypeId).push({ entityId, componentsToUpdate: mod.additions });
				}
			} else {
				const sourceArchetypeMask = this.archetypeManager.archetypeMasks[sourceArchetypeId];
				const targetArchetypeMask = (sourceArchetypeMask | addMask) & ~removeMask;
				const location = this.archetypeManager.archetypeEntityMaps[sourceArchetypeId].get(entityId);
				if (!location) continue;

				const targetArchetypeId = this.archetypeManager.getArchetypeByMask(targetArchetypeMask);

				if (!moves.has(sourceArchetypeId)) moves.set(sourceArchetypeId, new Map());
				const sourceMoves = moves.get(sourceArchetypeId);
				if (!sourceMoves.has(targetArchetypeId)) {
					sourceMoves.set(targetArchetypeId, { entityIds: [], sourceLocations: [], componentsToAssignArrays: [] });
				}
				const targetMoveData = sourceMoves.get(targetArchetypeId);
				targetMoveData.entityIds.push(entityId);
				targetMoveData.sourceLocations.push(location);
				targetMoveData.componentsToAssignArrays.push(mod.additions);
			}
		}

		for (const [archetypeId, updates] of inPlaceUpdates.entries()) {
			this.archetypeManager._setEntitiesComponents(archetypeId, updates, this.systemManager.currentTick);
		}

		if (moves.size > 0) {
			this.archetypeManager.moveEntitiesInBatch(moves);
		}
	}

	/**
	 * Executes all batched deletion commands.
	 * @private
	 */
	_flushDeletions() {
		if (this._deletions.size > 0) {
			this.entityManager.destroyEntitiesInBatch(this._deletions);
		}
	}

	/**
	 * Executes all batched creation commands.
	 * @private
	 */
	_flushCreations() {
		for (const [archetypeId, componentIdMaps] of this._creations.entries()) {
			this.entityManager.createEntitiesInArchetype(archetypeId, componentIdMaps);
		}

		for (const [archetypeId, batches] of this._identicalCreations.entries()) {
			for (const batch of batches) {
				// This calls the hyper-optimized batch creation method on the entity manager.
				this.entityManager.createIdenticalEntitiesInArchetype(archetypeId, batch.map, batch.count);
			}
		}
	}

	/**
	 * Gets a reusable modification tracking object from a pool.
	 * @returns {Modification}
	 * @private
	 */
	_getModObject() {
		if (this._modificationPoolIndex < this._modificationPool.length) {
			return this._modificationPool[this._modificationPoolIndex++];
		}
		const mod = new Modification();
		this._modificationPool.push(mod);
		this._modificationPoolIndex++;
		return mod;
	}

	_resetModPool() {
		for (let i = 0; i < this._modificationPoolIndex; i++) {
			this._modificationPool[i].reset();
		}
		this._modificationPoolIndex = 0;
	}
}
