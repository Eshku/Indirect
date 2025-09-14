/**
 * Manually loads all manager instances via direct imports.
 * This provides an explicit and clear loading process, removing the need for dynamic discovery.
 *
 * @returns {Promise<Map<string, object>>} A promise that resolves to a map where keys
 *   are manager class names (e.g., 'ComponentManager') and values are the
 *   manager instances.
 */
export async function loadAllManagers() {
	const loadedManagers = new Map()
	//! prep for restructure, no auto-load for now
	// --- Core Engine & ECS Foundation ---
	const { componentManager } = await import(`${PATH_ECS}/ComponentManager/ComponentManager.js`)
	loadedManagers.set('ComponentManager', componentManager)

	const { layerManager } = await import(`${PATH_MANAGERS}/LayerManager/LayerManager.js`)
	loadedManagers.set('LayerManager', layerManager)

	const { gameManager } = await import(`${PATH_MANAGERS}/GameManager/GameManager.js`)
	loadedManagers.set('GameManager', gameManager)

	const { physicsManager } = await import(`${PATH_MANAGERS}/PhysicsManager/PhysicsManager.js`)
	loadedManagers.set('PhysicsManager', physicsManager)

	const { prefabManager } = await import(`${PATH_MANAGERS}/PrefabManager/PrefabManager.js`)
	loadedManagers.set('PrefabManager', prefabManager)

	const { assetManager } = await import(`${PATH_MANAGERS}/AssetManager/AssetManager.js`)
	loadedManagers.set('AssetManager', assetManager)

	const { entityManager } = await import(`${PATH_ECS}/EntityManager/EntityManager.js`)
	loadedManagers.set('EntityManager', entityManager)

	const { archetypeManager } = await import(`${PATH_ECS}/ArchetypeManager/ArchetypeManager.js`)
	loadedManagers.set('ArchetypeManager', archetypeManager)

	// --- Logic & System Orchestration ---
	const { queryManager } = await import(`${PATH_MANAGERS}/QueryManager/QueryManager.js`)
	loadedManagers.set('QueryManager', queryManager)

	const { systemManager } = await import(`${PATH_ECS}/SystemManager/SystemManager.js`)
	loadedManagers.set('SystemManager', systemManager)

	// --- User-Facing systems ---
	const { uiManager } = await import(`${PATH_MANAGERS}/UiManager/UiManager.js`)
	loadedManagers.set('UiManager', uiManager)

	const { inputManager } = await import(`${PATH_MANAGERS}/InputManager/InputManager.js`)
	loadedManagers.set('InputManager', inputManager)

	// --- Utility & Development ---
	const { testManager } = await import(`${PATH_MANAGERS}/TestManager/TestManager.js`)
	loadedManagers.set('TestManager', testManager)

	return loadedManagers
}
