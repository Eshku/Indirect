export class Rotation {
	static schema = {
		angle: 'f64',
	}
	constructor({ angle = 0 } = {}) {
		this.angle = angle
	}
}
