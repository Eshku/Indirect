/**
 * A data-driven component that declares an effect to be triggered when an entity dies.
 * This is processed by the DeathAnimationSystem at the end of the DYING state.
 */
export const triggersOnDeath = {
	/**
	 * The numeric reference to the interned string of the "effect prefab" to instantiate.
	 * The prefab name is interned by the PayloadCompiler.
	 */
	// The 'string' type is automatically interned by the engine.
	prefabRef: { type: 'string', default: 'No prefab provided for triggersOnDeath' },
}
