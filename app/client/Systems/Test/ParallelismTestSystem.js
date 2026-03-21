const { engine } = await import(`@client/Engine.js`)
const { ecs, layerManager } = engine.getManagers()

const { position, velocity, column, parallelismTestTag } = ecs.getTypeIDs()
const { parallelismTest } = ecs.getKernelIDs()

const WORLD_WIDTH = 800
const LEFT_BOUNDARY = WORLD_WIDTH * 0.1
const RIGHT_BOUNDARY = WORLD_WIDTH * 0.9

/**
 * A self-contained, system to test and verify the three-phase parallel execution model.
 * It spawns its own entities, runs logic on them in parallel, and syncs their state to PIXI Sprites,
 * all without relying on other systems.
 *
 * ---
 *
 * **Symptom 1 (Crash):** The `schedule` method tries to access `context.position`, which is
 * now `undefined`, causing a `TypeError: Cannot read properties of undefined`.
 *
 * - Either lost context or context is overwriten by another system group (frequency group)
 *
 * **Symptom 2 (Visual Glitch):** Some chunks are "out of sync" - that is a bug if system is running on fixed timestep.
 * out-of-sync context - if delta is incorrect || some racing shit.
 *
 * Symptom 3 - particles going astray, not on chunk level , but on individual level.
 * We are most likely fucked. Data corruption, paddings, anything could happen at this point.
 *
 *
 * What is expected:
 * Particles form perfectly straight lines with exact same distance between lines.
 * No "fat" lines (double lines), no wondering pixels.
 * Running system on variable framerate could cause sync issues, but that is expected.
 * "Wobbly" lines movement is expected due to subpixel rendering.
 *
 *
 */
export class ParallelismTestSystem {
	static dependencies = {
		parallelismTest: {
			reads: [velocity],
			writes: [position],
			context: {
				position,
				velocity,
				rightBoundary: RIGHT_BOUNDARY,
				leftBoundary: LEFT_BOUNDARY,
			},
		},
		process: {
			reads: [position, column],
		},
	}

	init() {
		// --- PIXI Setup ---
		this.particleContainer = new PIXI.Container()
		this.textContainer = new PIXI.Container()
		this.labelBackgrounds = new PIXI.Graphics()
		this.entitySprites = new Map()
		this.debugLabels = new Map()
		this.spritesInitialized = false

		layerManager.getLayer('gameContainer').addChild(this.particleContainer)
		layerManager.getLayer('gameContainer').addChild(this.labelBackgrounds)
		layerManager.getLayer('gameContainer').addChild(this.textContainer)

		// Create a reusable 4x4 white texture for the sprites.
		// This is much more performant than drawing graphics every frame.
		const canvas = document.createElement('canvas')
		canvas.width = 4
		canvas.height = 4
		const ctx = canvas.getContext('2d')
		ctx.fillStyle = 'white'
		ctx.fillRect(0, 0, 4, 4)
		this.particleTexture = PIXI.Texture.from(canvas)

		//  Transpiler will automatically pick this.worldWidth` up and add it to `context` object.

		this.worldWidth = WORLD_WIDTH
		this.worldHeight = 1000

		// --- Test Configuration ---
		this.topMargin = 50 // The space at the top to reserve for labels.

		// number of columns will be derived from these settings.
		this.totalChunksToCreate = 30 // Total number of chunks to fill with test entities.
		this.chunksPerColumn = 10 // Each column will be made of entities from this many chunks.

		this.leftBoundary = LEFT_BOUNDARY
		this.rightBoundary = RIGHT_BOUNDARY

		this.query = this.getQuery({
			with: [position, velocity, parallelismTestTag, column],
		})

		const { payload, mutators } = this.compile({
			position: { x: 0, y: 0 },
			velocity: { x: 1, y: 0 },
			parallelismTestTag: {}, // Tag for this system's entities
			column: { index: 0 }, // Component to identify which column an entity belongs to
		})
		this.creationPayload = payload
		this.creationMutators = mutators

		// --- Visual Test Setup: Create a Grid of Entities ---
		// We will create long, continuous vertical columns of entities. Each column spans
		// multiple chunks. This makes it easy to visually detect if chunks are processed
		// out of sync, as it would create a horizontal "tear" in a column.

		// 1. Calculate how many entities of our test archetype fit into one chunk.
		// We use the same logic as the EntityManager to get a precise count.
		const TARGET_CHUNK_SIZE_BYTES = 16384 // 16KB
		const MIN_CHUNK_CAPACITY = 16
		const archetypeId = this.creationPayload.archetypeId
		const bytesPerEntity = ecs.entityManager.getBytesPerEntityInArchetype(archetypeId)
		const entitiesPerChunk = Math.max(
			MIN_CHUNK_CAPACITY,
			bytesPerEntity > 0 ? Math.floor(TARGET_CHUNK_SIZE_BYTES / bytesPerEntity) : MIN_CHUNK_CAPACITY,
		)

		// For reference, the byte size is calculated as:
		// Entity ID (8) + Position (16) + Velocity (16) + ParallelismTestTag (0) + Column (1) = 41 bytes per entity.
		// entitiesPerChunk = floor(16384 / 41) = 399.
		// console.log(`[ParallelismTest] Bytes per entity: ${bytesPerEntity}, Entities per chunk: ${entitiesPerChunk}`)

		// 2. Derive column count and total entities from chunk configuration.
		const columnCount = Math.floor(this.totalChunksToCreate / this.chunksPerColumn)
		if (columnCount === 0) {
			console.warn('[ParallelismTest] totalChunksToCreate is less than chunksPerColumn. No columns will be created.')
			return
		}
		const columnSpacing = (this.rightBoundary - this.leftBoundary) / (columnCount > 1 ? columnCount - 1 : 1)
		const entitiesPerColumn = this.chunksPerColumn * entitiesPerChunk
		const totalEntitiesToCreate = columnCount * entitiesPerColumn

		// 3. Create the entities column by column.
		for (let i = 0; i < totalEntitiesToCreate; i++) {
			const columnIndex = Math.floor(i / entitiesPerColumn)
			const entityIndexInColumn = i % entitiesPerColumn

			// Position entities to form vertical columns.
			this.creationMutators.position.x[0] = this.leftBoundary + columnIndex * columnSpacing
			this.creationMutators.position.y[0] =
				this.topMargin + (entityIndexInColumn / entitiesPerColumn) * (this.worldHeight - this.topMargin)
			this.creationMutators.column.index[0] = columnIndex

			this.createEntity(this.creationPayload)
		}
	}

	_initializeSprites() {
		// This runs once on the first update, after entities have been created by `init`.
		// It populates our sprite map, so the `update` loop can be a simple, hot loop.
		for (const chunk of this.query.iter()) {
			const entities = chunk.entities
			for (let i = 0; i < chunk.size; i++) {
				const entityId = entities[i]
				const sprite = new PIXI.Sprite(this.particleTexture)
				sprite.anchor.set(0.5)
				this.entitySprites.set(entityId, sprite)
				this.particleContainer.addChild(sprite)
			}
		}

		// Check if we actually found and initialized any sprites.
		if (this.entitySprites.size > 0) {
			this.spritesInitialized = true
			console.log(`[ParallelismTest] Initialized ${this.entitySprites.size} sprites.`)
		}
	}

	/**
	 * @param {import('../../Managers/SystemManager/JobWriter.js').JobWriter} jobWriter
	 */
	schedule(jobWriter) {
		jobWriter.scheduleForEachChunk(this.query, parallelismTest)
	}

	process({ deltaTime, currentTick }) {
		// --- 1. Initialize Sprites (if needed) ---
		if (!this.spritesInitialized) {
			this._initializeSprites()
			if (!this.spritesInitialized) return
		}

		// --- 2. Render Particles and Debug Labels ---
		this.labelBackgrounds?.clear?.()
		const columnInfo = new Map() // Map<columnIndex, {x: number, chunkIds: Set}>

		// Update sprite positions and gather debug info in a single, streamlined loop.
		for (const chunk of this.query.iter()) {
			const entities = chunk.entities
			const positions = chunk.componentData[position]
			const columns = chunk.componentData[column]

			for (let i = 0; i < chunk.size; i++) {
				const entityId = entities[i]
				const x = positions.x[i]
				const y = positions.y[i]

				const sprite = this.entitySprites.get(entityId)
				sprite.position.set(x, y)

				const columnIndex = columns.index[i]
				if (!columnInfo.has(columnIndex)) {
					columnInfo.set(columnIndex, { x: 0, chunkIds: new Set() })
				}
				const info = columnInfo.get(columnIndex)
				info.x = x // All x values in a column are the same, so we can just overwrite.
				info.chunkIds.add(chunk.chunkId)
			}
		}

		// Draw the text labels above each column.
		this.labelBackgrounds.fill({ color: 0x000000, alpha: 0.5 })
		for (const [columnIndex, info] of columnInfo.entries()) {
			const chunkText = `${[...info.chunkIds].join(',')}`
			let textObject = this.debugLabels.get(columnIndex)

			if (!textObject) {
				textObject = new PIXI.Text({
					text: '',
					style: { fontFamily: 'Arial', fontSize: 10, fill: 0x00ff00 },
				})
				this.debugLabels.set(columnIndex, textObject)
				this.textContainer.addChild(textObject)
			}
			textObject.text = chunkText
			textObject.x = info.x - 20
			textObject.y = 15

			const textBounds = textObject.getBounds()
			this.labelBackgrounds.rect(textBounds.x - 4, textBounds.y - 2, textBounds.width + 8, textBounds.height + 4)
		}

		// --- 3. Verification Step ---
		// This now runs in the same phase as the visual update, after all parallel jobs are complete.
		if (currentTick % 60 !== 0) return

		const columns = new Map()

		// Group all entities by their column index.
		for (const chunk of this.query.iter()) {
			const positions = chunk.componentData[position]
			const columnIndices = chunk.componentData[column]

			for (let i = 0; i < chunk.size; i++) {
				const columnIndex = columnIndices.index[i]
				const x = positions.x[i]

				if (!columns.has(columnIndex)) {
					columns.set(columnIndex, [])
				}
				columns.get(columnIndex).push(x)
			}
		}

		// Verify that all entities within each column have the same X position.
		for (const [columnIndex, xPositions] of columns.entries()) {
			const firstX = xPositions[0]
			if (!xPositions.every(x => x === firstX)) {
				console.warn(`[ParallelismTest] Inconsistency detected in column ${columnIndex}! X positions:`, xPositions)
			}
		}
	}

	destroy() {
		// --- HMR Cleanup ---
		// On hot-swap, destroy any entities that were created by the previous instance of this system.
		// Use the efficient chunk-based destruction. This query will find all entities with the tag
		for (const chunk of this.query.iter()) this.destroyEntitiesInChunk(chunk)

		// Destroy all PIXI objects created by this system.
		if (this.particleContainer) {
			// Destroying the container will also destroy all its children (the sprites).
			this.particleContainer.destroy({ children: true })
			this.particleContainer = null
		}
		if (this.labelBackgrounds) {
			this.labelBackgrounds.destroy()
			this.labelBackgrounds = null
		}
		if (this.textContainer) {
			this.textContainer.destroy({ children: true })
			this.textContainer = null
		}
		if (this.particleTexture) {
			this.particleTexture.destroy()
			this.particleTexture = null
		}

		// Clear maps to release references.
		this.entitySprites?.clear()
		this.entitySprites = null
		this.debugLabels?.clear()
		this.debugLabels = null
	}
}
