export class Scale {
	static schema = {
		x: 'f64',
		y: 'f64',
	}
	constructor({ x = 1, y = 1 } = {}) {
		this.x = x
		this.y = y
	}
}
