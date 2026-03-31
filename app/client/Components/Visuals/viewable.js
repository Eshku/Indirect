/**
 * A component that holds a managed reference to a visual asset, like a PIXI.Sprite.
 * This allows an entity to be represented visually on the screen. The actual sprite
 * object is stored and managed by the AssetManager.
 */

export const viewable = {
    isTrackable: true,
    spriteRef: { type: 'u32', default: 0 },
}
