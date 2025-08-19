/**
 * @fileoverview A collection of spline utility functions.
 */

/**
 * Calculates a point on a Catmull-Rom spline.
 * This function is used to generate smooth curves that pass through a given set of points.
 *
 * @param {number} t - The interpolation factor, a value between 0 and 1.
 * @param {import('pixi.js').PointData} p0 - The first control point (point before the segment starts).
 * @param {import('pixi.js').PointData} p1 - The second control point (start of the curve segment).
 * @param {import('pixi.js').PointData} p2 - The third control point (end of the curve segment).
 * @param {import('pixi.js').PointData} p3 - The fourth control point (point after the segment ends).
 * @param {import('pixi.js').PointData} [outPoint={x:0, y:0}] - Optional. An object to store the results in to avoid allocation.
 * @returns {import('pixi.js').PointData} The calculated point on the spline.
 */
export function getCatmullRomPoint(t, p0, p1, p2, p3, outPoint = { x: 0, y: 0 }) {
	const t2 = t * t
	const t3 = t2 * t

	// The standard Catmull-Rom spline formula
	outPoint.x =
		0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3)
	outPoint.y =
		0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)

	return outPoint
}