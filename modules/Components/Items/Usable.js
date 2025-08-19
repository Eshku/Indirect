/**
 * A "hot" component that defines an entity as being "usable" (like a skill or item)
 * and stores its use time. The actual effects are defined by child "effect entities"
 * linked via the `Parent` component, following the relational ECS pattern.
 */
export class Usable {
	/**
	 * @type {{useTime: string}}
	 */
	static schema = {
		useTime: 'f32',
	}
	constructor({ useTime = 0 } = {}) {
		this.useTime = useTime
	}
}
