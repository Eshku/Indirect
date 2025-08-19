/**
 * @fileoverview A collection of common easing functions.
 * These functions take a value `t` from 0 to 1 and return an eased value.
 * They are useful for creating smooth, natural-feeling animations and transitions.
 *
 * Based on the work of Robert Penner. See https://easings.net/ for visual examples.
 */
export const Easing = {
	linear: t => t,
	easeInQuad: t => t * t,
	easeOutQuad: t => t * (2 - t),
	easeInOutQuad: t => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
	easeInCubic: (t) => t * t * t,
	easeOutCubic: (t) => 1 - (1 - t) ** 3,
	easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
	// Quart, Quint, Sine, Expo, Circ, Back, Elastic, Bounce
}