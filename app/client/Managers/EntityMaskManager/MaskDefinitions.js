// This top-level await is safe because ComponentManager is guaranteed to be initialized
// by the Engine before entityMaskManager.
const { componentManager } = await import(`@managers/ComponentManager/ComponentManager.js`)
const { getConstantsForProperty } = await import(`@managers/ComponentManager/ComponentConstants.js`)

const {
	lifecycleState,
	hitFlash,
	immunity,
	weaponCooldown,
	health,
	hitHistory,
	viewable,
	scale,
	reactivityComponent,
	damageCollisionBuffer,
	physicsCollisionBuffer,
	spriteDescriptor,
	tint,
	visibility,
	trackedTestComponent,
	layer,
} = componentManager.getTypeIDs()

const LIFECYCLE = getConstantsForProperty(lifecycleState, 'state')

export const MaskDefinitions = {
	//lifecycle
	isSpawning: {
		
		rule: { with: [lifecycleState] },
		autoMaskOnValue: { component: lifecycleState, property: 'state' }, // Value is auto-derived from mask name
	},
	isActive: {
		
		rule: { with: [lifecycleState] },
		autoMaskOnValue: { component: lifecycleState, property: 'state' }, // Value is auto-derived from mask name
	},
	isDying: {
		
		rule: { with: [lifecycleState] },
		autoMaskOnValue: { component: lifecycleState, property: 'state' }, // Value is auto-derived from mask name
	},
	isDead: {
		
		rule: { with: [lifecycleState] },
		autoMaskOnValue: { component: lifecycleState, property: 'state' }, // Value is auto-derived from mask name
	},
	isPooled: {
		
		rule: { with: [lifecycleState] },
		autoMaskOnValue: { component: lifecycleState, property: 'state' }, // Value is auto-derived from mask name
	},

	// --- Enableable Masks (formerly meta: { isEnableable: true }) ---
	isHitFlashEnabled: {
		
		rule: { with: [hitFlash] },
		isEnableableFor: hitFlash, // Links this mask to the component for enableComponent(..., hitFlash)
	},
	isImmunityEnabled: {
		
		rule: { with: [immunity] },
		isEnableableFor: immunity,
	},
	isWeaponCooldownEnabled: {
		
		rule: { with: [weaponCooldown] },
		isEnableableFor: weaponCooldown,
	},
}
