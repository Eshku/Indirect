/**
 * Static manifest for all InstantEventChannels in the application.
 * Channels defined here are created by the EventManager at startup and are
 * available to all systems on both the main thread and worker threads.
 */
export const eventChannels = {
    testEvents: {
        schema: { value: 'u32', tick: 'u32' },
        capacity: 2048,
    },
    // Example for a future damage system
    // damageEvents: {
    //     schema: { amount: 'f32', target: 'u64', source: 'u64' },
    //     capacity: 4096,
    // },
};