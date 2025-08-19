export class SpawnProjectile {
	static schema = {
		target: {
			type: 'enum',
			of: 'u8',
			values: ['Direction', 'Point', 'Entity'],
		},
		projectilePrefab: { type: 'string' },
	}

	constructor({ target = 0, projectilePrefab = '' } = {}) {
		this.target = target
		this.projectilePrefab = projectilePrefab
	}
}