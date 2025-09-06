/**
 * @fileoverview A central mapping for formula variables to component names.
 * This provides a single source of truth for how variables used in formula strings
 * (e.g., "STR", "INT") correspond to actual component classes in the engine.
 */
export const FORMULA_VARIABLE_MAP = {
	STR: 'Strength',
	DEX: 'Dexterity',
	INT: 'Intelligence',
	VIT: 'Vitality',
}