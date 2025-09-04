/**
 * Converts screen coordinates to world coordinates by applying the inverse
 * of a container's transformation. This is useful for camera systems where
 * a container represents the "world" and is moved around.
 * @param {PIXI.PointData} screenPoint - The point in screen space to convert.
 * @param {PIXI.Container} worldContainer - The container representing the world.
 * @param {PIXI.Point} [outPoint] - Optional point to store the result in.
 * @returns {PIXI.Point} The converted point in world space.
 */
export function screenToWorld(screenPoint, worldContainer, outPoint) {
	// If there's no worldContainer, world space is the same as screen space.
	if (!worldContainer) {
		if (outPoint) return outPoint.copyFrom(screenPoint)
		return new PIXI.Point(screenPoint.x, screenPoint.y)
	}

	// The 'true' skips the global transform update for the container,
	// which is a performance optimization if we know the transforms are up-to-date.
	// This is often the case when called within the game loop after transforms have been calculated.
	return worldContainer.toLocal(screenPoint, undefined, outPoint, true)
}
