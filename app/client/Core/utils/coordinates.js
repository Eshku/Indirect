/**
 * Converts a point from screen space (e.g., mouse cursor) to world space.
 * This accounts for the camera's position by considering the game container's transform.
 *
 * @param {import('pixi.js').PointData} screenPoint - The point in screen coordinates.
 * @param {import('pixi.js').Container} gameContainer - The main container for the game world.
 * @param {import('pixi.js').PointData} [outPoint={x:0, y:0}] - Optional. An object to store the results in.
 * @returns {import('pixi.js').PointData} The point in world coordinates.
 */
export function screenToWorld(screenPoint, gameContainer, outPoint = { x: 0, y: 0 }) {
	if (!gameContainer) {
		console.error("coordinates.js: 'gameContainer' is required for screenToWorld conversion.");
		outPoint.x = screenPoint.x;
		outPoint.y = screenPoint.y;
		return outPoint;
	}

	outPoint.x = screenPoint.x - gameContainer.x;
	// And we must invert the Y-axis because our world is Y-up, but screen is Y-down.
	outPoint.y = -(screenPoint.y - gameContainer.y);

	return outPoint;
}