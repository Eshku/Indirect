const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { Position, Velocity, CreationDestructionTag } = componentManager.getComponents()

/**
 * @fileoverview A system for stress-testing entity creation and destruction performance.
 */
export class CreationDestructionBenchmarkSystem {
	constructor() {
		this.query = queryManager.getQuery({
			with: [CreationDestructionTag],
		})

		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.tagTypeID = componentManager.getComponentTypeID(CreationDestructionTag)

		//prev 50k / 7k
		//current 50k / 6k
		this.poolSize = 50_000
		this.churnRate = 6000

		this.creationMap = new Map([
			[this.positionTypeID, { x: 0, y: 0 }],
			[this.velocityTypeID, { x: 0, y: 0 }],
			[this.tagTypeID, {}],
		])
	}

	init() {
		this._spawn(this.poolSize)
	}

	update() {
		let destroyedCount = 0
		destructionLoop: for (const chunk of this.query.iter()) {
			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (destroyedCount >= this.churnRate) {
					break destructionLoop
				}
				this.commands.destroyEntity(chunk.entities[indexInChunk])
				destroyedCount++
			}
		}

		this._spawn(destroyedCount)
	}

	_spawn(count) {
		for (let i = 0; i < count; i++) {
			this.commands.createEntity(this.creationMap)
		}
	}
}
