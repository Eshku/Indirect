const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()
const { MASK_PARTS } = await import(`@managers/EntityManager/EntityManager.js`)
const { h64Raw } = await xxhash()

// Copy of the FNV-1a implementation from EntityManager.js for a direct comparison.
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
function fnv1a64(data) {
	let hash = FNV_OFFSET_BASIS
	for (let i = 0; i < data.length; i++) {
		hash ^= BigInt(data[i])
		hash = (hash * FNV_PRIME) & 0xffffffffffffffffn
	}
	return hash
}

const CONFIG = {
	NUM_ARCHETYPES: 1024, // Number of unique "archetypes" to hash
	ITERATIONS: 50000, // Number of times to hash the entire set
}

export class HashingBenchmarkSystem {
	async init() {
		console.log('%c[HashingBenchmark] Starting benchmark...', 'color: #4e9a06; font-weight: bold;')

		// 1. Generate realistic keys (archetype masks)
		const keys = []
		const keysAsUint8 = []
		for (let i = 0; i < CONFIG.NUM_ARCHETYPES; i++) {
			const buffer = new SharedArrayBuffer(MASK_PARTS * BigUint64Array.BYTES_PER_ELEMENT)
			const key = new BigUint64Array(buffer)
			for (let j = 0; j < MASK_PARTS; j++) {
				key[j] = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))
			}
			keys.push(key)
			// Create a Uint8Array view for the WASM function, which expects a byte array.
			keysAsUint8.push(new Uint8Array(key.buffer, key.byteOffset, key.byteLength))
		}
		console.log(`[HashingBenchmark] Generated ${CONFIG.NUM_ARCHETYPES} keys. Running ${CONFIG.ITERATIONS} iterations...`)

		// --- 2. Benchmark Pure JS FNV-1a ---
		const fnvStart = performance.now()
		for (let i = 0; i < CONFIG.ITERATIONS; i++) {
			for (const key of keys) {
				fnv1a64(key)
			}
		}
		const fnvTime = performance.now() - fnvStart

		// --- 3. Benchmark xxhash-wasm ---
		const wasmStart = performance.now()
		for (let i = 0; i < CONFIG.ITERATIONS; i++) {
			for (const keyView of keysAsUint8) {
				h64Raw(keyView)
			}
		}
		const wasmTime = performance.now() - wasmStart

		// --- 4. Report Results ---
		console.log('%c[HashingBenchmark] Results:', 'color: #4e9a06; font-weight: bold;')
		console.log(`Pure JS (FNV-1a): ${fnvTime.toFixed(2)} ms`)
		console.log(`WASM (xxhash):    ${wasmTime.toFixed(2)} ms`)

		const winner = fnvTime < wasmTime ? 'FNV-1a (JS)' : 'xxhash (WASM)'
		const difference = Math.abs(fnvTime - wasmTime)
		const percentage = (difference / Math.min(fnvTime, wasmTime)) * 100

		console.log(`%cWinner: ${winner} by ${difference.toFixed(2)} ms (${percentage.toFixed(2)}%)`, 'color: #729fcf; font-weight: bold;')
	}

	destroy() {}
}