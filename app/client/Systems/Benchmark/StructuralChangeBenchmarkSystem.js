const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { ComponentA, ComponentB } = componentManager.getComponents()

const benchmarkConfig = {
	// true / false
	runPerEntity: true,
	runQueryBased: false,
}

/**
 * @fileoverview A system for stress-testing structural changes (adding/removing components).
 */
export class StructuralChangeBenchmarkSystem {
	constructor() {
		this.addQuery = queryManager.getQuery({
			with: [ComponentA],
			without: [ComponentB],
		})

		this.removeQuery = queryManager.getQuery({
			with: [ComponentA, ComponentB],
		})

		this.componentATypeID = componentManager.getComponentTypeID(ComponentA)
		this.componentBTypeID = componentManager.getComponentTypeID(ComponentB)

		this.entityCount = 5_000

		this.creationMap = new Map([[this.componentATypeID, {}]])
	}

	init() {
		for (let i = 0; i < this.entityCount; i++) {
			this.commands.createEntity(this.creationMap)
		}
	}

	update(deltaTime, currentTick) {
		if (benchmarkConfig.runPerEntity) {
			this._updatePerEntity(currentTick)
		} else if (benchmarkConfig.runQueryBased) {
			this._updateQueryBased(currentTick)
		}
	}

	_updatePerEntity(currentTick) {
		if (currentTick % 2 === 0) {
			for (const chunk of this.addQuery.iter()) {
				for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
					this.commands.addComponent(chunk.entities[indexInChunk], this.componentBTypeID, {})
				}
			}
		} else {
			for (const chunk of this.removeQuery.iter()) {
				for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
					this.commands.removeComponent(chunk.entities[indexInChunk], this.componentBTypeID)
				}
			}
		}
	}

	_updateQueryBased(currentTick) {
		if (currentTick % 2 === 0) {
			this.commands.addComponentToQuery(this.addQuery, this.componentBTypeID, {})
		} else {
			this.commands.removeComponentFromQuery(this.removeQuery, this.componentBTypeID)
		}
	}
}
