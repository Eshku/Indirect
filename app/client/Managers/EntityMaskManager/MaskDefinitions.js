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

export const MASK_TYPE = {
	STATE: 0,
	EVENT: 1,
}

export const MaskDefinitions = {
	//lifecycle
	isSpawning: {
		type: MASK_TYPE.STATE,
		rule: { with: [lifecycleState] },
		autoMaskOnValue: { component: lifecycleState, property: 'state' }, // Value is auto-derived from mask name
	},
	isActive: {
		type: MASK_TYPE.STATE,
		rule: { with: [lifecycleState] },
		autoMaskOnValue: { component: lifecycleState, property: 'state' }, // Value is auto-derived from mask name
	},
	isDying: {
		type: MASK_TYPE.STATE,
		rule: { with: [lifecycleState] },
		autoMaskOnValue: { component: lifecycleState, property: 'state' }, // Value is auto-derived from mask name
	},
	isDead: {
		type: MASK_TYPE.STATE,
		rule: { with: [lifecycleState] },
		autoMaskOnValue: { component: lifecycleState, property: 'state' }, // Value is auto-derived from mask name
	},
	isPooled: {
		type: MASK_TYPE.STATE,
		rule: { with: [lifecycleState] },
		autoMaskOnValue: { component: lifecycleState, property: 'state' }, // Value is auto-derived from mask name
	},

	// --- Enableable Masks (formerly meta: { isEnableable: true }) ---
	isHitFlashEnabled: {
		type: MASK_TYPE.STATE,
		rule: { with: [hitFlash] },
		isEnableableFor: hitFlash, // Links this mask to the component for enableComponent(..., hitFlash)
	},
	isImmunityEnabled: {
		type: MASK_TYPE.STATE,
		rule: { with: [immunity] },
		isEnableableFor: immunity,
	},
	isWeaponCooldownEnabled: {
		type: MASK_TYPE.STATE,
		rule: { with: [weaponCooldown] },
		isEnableableFor: weaponCooldown,
	},

	// --- Trackable/Modified Masks (formerly meta: { isTrackable: true }) ---
	wasLifecycleStateModified: {
		type: MASK_TYPE.EVENT,
		rule: { with: [lifecycleState] },
		isModifiedFor: lifecycleState, // Links this mask to the component for getDirty(..., lifecycleState)
	},
	wasHealthModified: {
		type: MASK_TYPE.EVENT,
		rule: { with: [health] },
		isModifiedFor: health,
	},
	wasHitHistoryModified: {
		type: MASK_TYPE.EVENT,
		rule: { with: [hitHistory] },
		isModifiedFor: hitHistory,
	},
	wasViewableModified: {
		type: MASK_TYPE.EVENT,
		rule: { with: [viewable] },
		isModifiedFor: viewable,
	},
	wasScaleModified: {
		type: MASK_TYPE.EVENT,
		rule: { with: [scale] },
		isModifiedFor: scale,
	},
	wasReactivityComponentModified: {
		type: MASK_TYPE.EVENT,
		rule: { with: [reactivityComponent] },
		isModifiedFor: reactivityComponent,
	},
	wasDamageCollisionBufferModified: {
		type: MASK_TYPE.EVENT,
		rule: { with: [damageCollisionBuffer] },
		isModifiedFor: damageCollisionBuffer,
	},
	wasPhysicsCollisionBufferModified: {
		type: MASK_TYPE.EVENT,
		rule: { with: [physicsCollisionBuffer] },
		isModifiedFor: physicsCollisionBuffer,
	},
	wasSpriteDescriptorModified: {
		type: MASK_TYPE.EVENT,
		rule: { with: [spriteDescriptor] },
		isModifiedFor: spriteDescriptor,
	},
	wasTintModified: {
		type: MASK_TYPE.EVENT,
		rule: { with: [tint] },
		isModifiedFor: tint,
	},
	wasVisibilityModified: {
		type: MASK_TYPE.EVENT,
		rule: { with: [visibility] },
		isModifiedFor: visibility,
	},
	wasTrackedTestComponentModified: {
		type: MASK_TYPE.EVENT,
		rule: { with: [trackedTestComponent] },
		isModifiedFor: trackedTestComponent,
	},
	wasLayerModified: {
		type: MASK_TYPE.EVENT,
		rule: { with: [layer] },
		isModifiedFor: layer,
	},
}
