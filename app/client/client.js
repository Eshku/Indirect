window.PATH_ROOT = await window.electronAPI.getRootDirectory()
await import(`${PATH_ROOT}/client/CONSTANTS.JS`)
const isDev = (await window.electronAPI.getEnv()) === 'development'

const { eventEmitter } = await import(`${PATH_CORE}/Classes/EventEmitter.js`)

const { engine } = await import(`${PATH_CLIENT}/Engine.js`)

await engine.init()

const { gameManager, assetManager, layerManager, uiManager, inputManager, ecs } = engine.getManagers()

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
layerManager.addLayer('vfx', { parent: 'gameContainer' })

// The debug layer should be a child of the gameContainer to move with the camera,
// but added last to draw on top of all other game elements.
layerManager.addLayer('debugContainer', { parent: 'gameContainer' })

/**
 * Procedurally generates a tileable starfield texture.
 * @param {PIXI.Application} app - The Pixi application instance.
 * @param {number} width - The width of the texture.
 * @param {number} height - The height of the texture.
 * @param {number} starCount - The number of stars to generate.
 * @returns {PIXI.Texture} The generated texture.
 */
function createStarfieldTexture(app, width, height, starCount) {
	const graphics = new PIXI.Graphics()

	// A dark blue/black for space
	graphics.rect(0, 0, width, height).fill(0x0c0c1a)

	// Generate stars
	for (let i = 0; i < starCount; i++) {
		const x = Math.random() * width
		const y = Math.random() * height
		const radius = Math.random() * 1.2
		const alpha = 0.5 + Math.random() * 0.5
		const color = Math.random() > 0.2 ? 0xffffff : 0xaaccff // Most are white, some are blueish

		graphics.circle(x, y, radius).fill({ color, alpha })
	}

	return app.renderer.generateTexture(graphics)
}

const setupBackground = async () => {
	const app = await gameManager.getApp()
	app.renderer.background.color = 0x0c0c1a // Fallback color

	const starfieldTexture = createStarfieldTexture(app, 512, 512, 400)
	const tilingSprite = new PIXI.TilingSprite({
		texture: starfieldTexture,
		width: app.screen.width,
		height: app.screen.height,
	})

	layerManager.getLayer('backgroundContainer').addChild(tilingSprite)
	layerManager.store('starfieldSprite', tilingSprite)

	app.renderer.on('resize', () => {
		tilingSprite.width = app.screen.width
		tilingSprite.height = app.screen.height
	})
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
		PIXI.Assets.load(`${PATH_ASSETS}/${atlasImageFile}`),
		fetch(`${PATH_ASSETS}/${atlasJsonFile}`).then(res => res.json()),
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
	// Load our procedurally generated texture atlas
	await loadAtlas('atlas')

	await ecs.prefabManager.preload(['player', 'spinner', 'cursor'])
}

const setupPlayer = async () => {
	ecs.instantiate('player')
}

const setupCursor = async () => {
	// Instantiate the data-only cursor entity so systems can find it.
	ecs.instantiate('cursor')
}

const setupTestEnemies = async () => {
	ecs.instantiate('spinner')
}

Logger.start('Setup')

await preload()
await setupBackground()
await setupPlayer()
await setupCursor()
await setupTestEnemies()

Logger.end('Setup')

await ecs.systemManager.initAll()
await ecs.systemManager.startLoop()
