/**
 * A collection of common easing functions.
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
	easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
	easeInQuart: t => t * t * t * t,
    easeOutQuart: t => 1 - Math.pow(1 - t, 4),
    easeInOutQuart: t => t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2,
    easeInQuint: t => t * t * t * t * t,
    easeOutQuint: t => 1 - Math.pow(1 - t, 5),
    easeInOutQuint: t => t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2,
    easeInSine: t => 1 - Math.cos((t * Math.PI) / 2),
    easeOutSine: t => Math.sin((t * Math.PI) / 2),
    easeInOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
}