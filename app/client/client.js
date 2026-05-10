const isDev = (await window.electronAPI.getEnv()) === 'development'

const { engine } = await import('@client/Engine.js')

await engine.init()

const { gameManager, assetManager, layerManager, uiManager, inputManager, ecs } = engine.getManagers()

const setupLayers = () => {
	// The order of layer creation determines the drawing order.
	// Top-level layers are sorted by zIndex.
	layerManager.addLayer('backgroundContainer', { order: 0 })
	layerManager.addLayer('gameContainer', { order: 1 })
	layerManager.addLayer('ui', { order: 2 })
	layerManager.addLayer('cursor', { order: 3 })

	// Child layers are drawn in the order they are added to their parent.
	layerManager.addLayer('pickups', { parent: 'gameContainer' })
	layerManager.addLayer('enemies', { parent: 'gameContainer' })
	layerManager.addLayer('projectiles', { parent: 'gameContainer' })
	layerManager.addLayer('player', { parent: 'gameContainer' })
	layerManager.addLayer('playerEffects', { parent: 'gameContainer' })
	layerManager.addLayer('vfx', { parent: 'gameContainer' })

	// The debug layer should be a child of the gameContainer to move with the camera,
	// but added last to draw on top of all other game elements.
	layerManager.addLayer('debugContainer', { parent: 'gameContainer' })
}

/**
 * Loads a texture atlas and its manifest, then registers each sub-texture with the AssetManager.
 * @param {string} atlasName - The base name for the atlas files (e.g., 'atlas' for 'atlas.png' and 'atlas.json').
 */
async function loadAtlas(atlasName) {
	const atlasImageFile = `${atlasName}.png`
	const atlasJsonFile = `${atlasName}.json`

	// Load the base texture and the manifest data
	const [baseTexture, manifest] = await Promise.all([
		PIXI.Assets.load(`./assets/${atlasImageFile}`),
		fetch(`./assets/${atlasJsonFile}`).then(res => res.json()),
	])

	// Store the entire manifest for later lookup of frame data by systems.
	assetManager.setAtlasManifest(manifest)

	// Also store the base texture itself under the atlas name for systems that need the whole sheet (e.g., InstancedRenderSystem).
	assetManager.addTexture(atlasName, baseTexture)

	// For each frame in the manifest, create a specific texture and add it to the AssetManager
	for (const [name, data] of Object.entries(manifest.frames)) {
		const frameRect = new PIXI.Rectangle(data.frame.x, data.frame.y, data.frame.w, data.frame.h)
		const texture = new PIXI.Texture({ source: baseTexture, frame: frameRect })
		assetManager.addTexture(name, texture)
	}
}

const preload = async () => {
	await loadAtlas('atlas')

	await ecs.prefabManager.preload([
		'player',

		'spinningDrone',
		'explosiveDrone',

		'cursor',

		'slashingArc',
		'shield',

		'smallExplosionEffect',

		'spawnDirector',
	])
}

const setupEntities = async () => {
	ecs.instantiate('player')

	ecs.instantiate('cursor')

	ecs.instantiate('shield')

	//ecs.instantiate('spinningDrone') // created automatically
	//ecs.instantiate('explosiveDrone') // created automatically

	ecs.instantiate('spawnDirector')
}

Logger.start('Setup')

setupLayers()
await preload()
await setupEntities()

await ecs.systemManager.initAll()

Logger.end('Setup')

await ecs.systemManager.startLoop()
