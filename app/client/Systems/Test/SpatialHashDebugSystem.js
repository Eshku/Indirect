const { engine } = await import(`@client/Engine.js`)
const { ecs, layerManager, physicsManager } = engine.getManagers()
const { eventEmitter } = await import(`@core/Classes/EventEmitter.js`)
const { SpatialHashGrid, NODE_STRIDE_U64 } = await import(`@core/DataStructures/SpatialHashGrid.js`)
const { Easing } = await import(`@core/utils/easing.js`)

/**
 * A debug system to visualize the state of the SpatialHashGrid in real-time.
 * It draws the grid lines and represents each entity within a cell as a small colored square.
 * This is a powerful tool for verifying that entities are being correctly added to the grid.
 */
export class SpatialHashDebugSystem {
	init() {
		// Get component type IDs once for efficient lookups in the update loop.
		const { playerTag, enemyTag, playerProjectile } = ecs.getComponentIDs()
		this.playerTagId = playerTag
		this.enemyTagId = enemyTag
		this.playerProjectileId = playerProjectile

		this.targetAlpha = 0.0 // 0.0 for hidden, 1.0 for visible
		this.animation = {
			progress: 1.0, // 0.0 (start) to 1.0 (end)
			duration: 0.4, // seconds
		}

		// Use a parent container to animate the alpha of all debug graphics at once.
		this.container = new PIXI.Container()
		this.container.alpha = 0.0

		// Use a standard Graphics object for the grid lines, which are few.
		this.gridGraphics = new PIXI.Graphics()

		// Use a highly optimized ParticleContainer for the cell highlights, which can be numerous.
		const maxCells = physicsManager.getSpatialHashGridSABs().config.MAX_NODES
		this.cellContainer = new PIXI.ParticleContainer({
			maxSize: maxCells,
			dynamicProperties: {
				// position is true by default, we don't need to set it.
				color: true, // This allows tint and alpha to be updated each frame.
			},
		})

		this.container.addChild(this.gridGraphics)
		this.container.addChild(this.cellContainer)

		// Get a read-only API instance for the grid, using the same shared buffers.
		this.grid = new SpatialHashGrid(physicsManager.getSpatialHashGridSABs())

		// Add the graphics to the main game container so it inherits camera transforms (like Y-axis inversion).
		const gameLayer = layerManager.getLayer('gameContainer')
		gameLayer.addChild(this.container)

		this.toggleListener = ({ isActive }) => {
			// Only toggle on the key press (isActive: true), not on release.
			if (isActive) {
				this.targetAlpha = this.targetAlpha === 0.0 ? 1.0 : 0.0
				// Restart the animation from the beginning on every toggle.
				this.animation.progress = 0.0
			}
		}
		eventEmitter.on('Input ToggleSpatialHashDebug', this.toggleListener)
	}

	update({ deltaTime }) {
		// Animate the alpha value using a time-based progression and easing functions.
		if (this.animation.progress < 1.0) {
			this.animation.progress = Math.min(1.0, this.animation.progress + deltaTime / this.animation.duration)

			const t = this.animation.progress
			if (this.targetAlpha === 1.0) {
				// Fade In: Start fast, end slow.
				this.container.alpha = Easing.easeOutCubic(t)
			} else {
				// Fade Out: Start slow, end fast to avoid "lingering".
				this.container.alpha = 1.0 - Easing.easeInCubic(t)
			}
		}

		// If completely invisible, do no more work for this frame.
		if (this.container.alpha === 0.0) {
			return
		}

		// If visible, clear old drawings and hide sprites before redrawing.
		this.gridGraphics.clear()
		let activeParticleCount = 0

		const [originX, originY] = this.grid.gridOriginView
		const { gridWidth, gridHeight, cellSize, nodeNextIndexView, nodeEntityIdView } = this.grid

		// --- 1. Draw Grid Lines ---
		for (let y = 0; y <= gridHeight; y++) {
			const worldY = originY + y * cellSize
			this.gridGraphics.moveTo(originX, -worldY)
			this.gridGraphics.lineTo(originX + gridWidth * cellSize, -worldY)
		}
		for (let x = 0; x <= gridWidth; x++) {
			const worldX = originX + x * cellSize
			this.gridGraphics.moveTo(worldX, -originY)
			this.gridGraphics.lineTo(worldX, -(originY + gridHeight * cellSize))
		}
		// In PixiJS v8, it's idiomatic to define the path first, then apply the stroke.
		this.gridGraphics.stroke({ width: 1, color: 0x444444, alpha: 0.4 })

		// --- 2. Draw Cell Contents ---
		for (let y = 0; y < gridHeight; y++) {
			for (let x = 0; x < gridWidth; x++) {
				const cellIndex = y * gridWidth + x
				const headNodeIndex = this.grid.gridCellsView[cellIndex]

				// If the cell is not empty, draw a highlight over it.
				if (headNodeIndex !== -1) {
					const cellWorldX = originX + x * cellSize
					const cellWorldY = originY + y * cellSize

					// For simplicity, we'll color the cell based on the first entity found.
					const firstEntityId = nodeEntityIdView[headNodeIndex * NODE_STRIDE_U64]

					// This is a more performant, data-oriented way to check an entity's type.
					// We get the archetype ID and check for component presence without string lookups.
					const archetypeId = ecs.entityManager.getArchetypeForEntity(firstEntityId)

					let color = 0x808080 // Default grey for unknown
					let alpha = 0.2

					if (ecs.entityManager.hasComponentType(archetypeId, this.playerTagId)) {
						color = 0x40ff40 // Bright Green
						alpha = 0.2
					} else if (ecs.entityManager.hasComponentType(archetypeId, this.enemyTagId)) {
						color = 0xff0000 // red
						alpha = 0.2
					} else if (ecs.entityManager.hasComponentType(archetypeId, this.playerProjectileId)) {
						color = 0x00ffff // Cyan
						alpha = 0.1
					}

					// Get a particle from the container's pool or create a new one if needed.
					let particle = this.cellContainer.particleChildren[activeParticleCount]
					if (!particle) {
						particle = new PIXI.Particle({ texture: PIXI.Texture.WHITE })
						this.cellContainer.addParticle(particle)
					}

					particle.tint = color
					particle.alpha = alpha
					particle.scaleX = cellSize / particle.texture.frame.width
					particle.scaleY = cellSize / particle.texture.frame.height
					particle.x = cellWorldX
					particle.y = -(cellWorldY + cellSize)
					activeParticleCount++
				}
			}
		}
		// After modifying the particleChildren array directly (by setting its length),
		// we must call update() to sync the changes with the underlying GPU buffers.
		this.cellContainer.particleChildren.length = activeParticleCount
		this.cellContainer.update()
	}

	destroy() {
		if (this.container) {
			eventEmitter.off('Input ToggleSpatialHashDebug', this.toggleListener)
			this.container.destroy({ children: true })
			this.container = null
			this.gridGraphics = null
			this.cellContainer = null
		}
	}
}
