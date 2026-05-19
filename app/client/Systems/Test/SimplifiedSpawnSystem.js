const { engine } = await import(`@client/Engine.js`)
const { ecs, entityManager, gameManager, physicsManager, prefabManager } = engine.getManagers()

const {
	spawnDirector,
	playerTag,
	position,
	lifecycleState,
	health,
	velocity,
	threatCost,
	tint,
	aiParameters,
	visibility,
	scale,
	spinningDroneTag,
	explosiveDroneTag,
} = ecs.getComponentIDs()

export class SimplifiedSpawnSystem {
	init() {
		this.creationPayload = this.compile(`spinningDrone`, {
			count: 100,
		})
	}

	update({ deltaTime, frameCounter }) {

		if (frameCounter % 60 === 0) this.instantiate(this.creationPayload, 1)
		//just spawn 1 entity every second
	}
}
