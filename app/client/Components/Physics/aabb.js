/**
 * A component to store the calculated Axis-Aligned Bounding Box of a collidable entity.
 * This is written to by the SpatialHashingSystem and read by the CollisionSystem
 * to avoid redundant calculations. It should be added to any entity with a collider.
 */
export const aabb = {
	minX: { type: 'f32', default: 0 },
	minY: { type: 'f32', default: 0 },
	maxX: { type: 'f32', default: 0 },
	maxY: { type: 'f32', default: 0 },
}