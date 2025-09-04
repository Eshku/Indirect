window.PATH_ROOT = await window.electronAPI.getRootDirectory()
await import(`${PATH_ROOT}/client/CONSTANTS.JS`)
const isDev = (await window.electronAPI.getEnv()) === 'development'

const { eventEmitter } = await import(`${PATH_CORE}/Classes/EventEmitter.js`)

const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)

await theManager.init()

// Load high-level ECS debugging utilities and expose them on the window (e.g., window.ECS)
await import(`${PATH_CORE}/ECS/ECS.js`)

const {
	gameManager,
	assetManager,
	systemManager,
	physicsManager,
	layerManager,
	entityManager,
	uiManager,
	inputManager,
	componentManager,
	prefabManager,
} = theManager.getManagers()

const setupBackground = async () => {
	const pixi = await gameManager.getApp()

	pixi.renderer.background.color = 0x333333
}

const preload = async () => {
	//assets

	await assetManager.loadAssetAsync('test_player', `${PATH_ASSETS}/sprites/stickman.png`)

	await assetManager.loadAssetAsync('fireball_icon', `${PATH_ICONS}/skills/64/fireball.png`)
	await assetManager.loadAssetAsync('searing_boulder_icon', `${PATH_ICONS}/skills/64/SearingBoulder.png`)

	await prefabManager.preload([
		'player_character',
		'platform',
		'fireball',
		'searing_boulder',
		'fireball_projectile',
		'searing_boulder_projectile',
	])
}

const setupPlayer = async () => {
	ECS.instantiate('player_character')
}

const setupPlatforms = async () => {
	ECS.instantiate('platform', { position: { x: 0, y: 0 } })
	ECS.instantiate('platform', { position: { x: 500, y: 50 } })
	ECS.instantiate('platform', { position: { x: -500, y: 50 } })
	ECS.instantiate('platform', { position: { x: 0, y: 300 } })
}

Logger.start('Setup')

await preload()
await setupBackground()
await setupPlayer()

await setupPlatforms()

await systemManager.initAll()

Logger.end('Setup')

await systemManager.startLoop()
