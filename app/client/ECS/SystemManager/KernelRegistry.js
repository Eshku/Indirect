import { toCamelCase } from '../../Core/utils/stringUtils.js'

/**
 * A central registry for all kernel functions.
 * It discovers all kernels, assigns them unique IDs, and provides mappings for the
 * main thread and workers.
 */
class KernelRegistry {
	constructor() {
		/**
		 * A map from a kernel function reference to its unique numeric ID.
		 * @type {Map<Function, number>}
		 */
		this.kernelToId = new Map()

		/**
		 * A map from a kernel's unique numeric ID back to its function reference.
		 * Used primarily for debugging on the main thread.
		 * @type {Map<number, Function>}
		 */
		this.idToKernel = new Map()

		/**
		 * A map from a kernel's exported name to its unique numeric ID.
		 * @type {Map<string, number>}
		 */
		this.kernelNameToId = new Map()

		/**
		 * A map from a kernel's unique numeric ID to its metadata.
		 * @type {Map<number, { name: string, moduleName: string }>}
		 */
		this.kernelMetadata = new Map()

		/**
		 * Stores the source code of all loaded kernel modules, keyed by module name.
		 * This is used to send the code to workers for initialization.
		 * @type {Object.<string, string>}
		 */
		this.kernelCode = {}

		this.nextKernelId = 1 // Start from 1. 0 can be a sentinel value.

		this._kernelIdObject = null
	}

	/**
	 * Registers all kernel functions from the loaded modules.
	 * @param {Map<string, object>} kernelModules - A map of loaded kernel modules from the loader.
	 * @param {Object.<string, string>} kernelCode - A map of kernel module names to their source code.
	 */
	registerKernelModules(kernelModules, kernelCode) {
		this.kernelCode = kernelCode

		for (const [moduleName, module] of kernelModules.entries()) {
			const kernelIdentifier = toCamelCase(moduleName)
			const kernelId = this.kernelNameToId.get(kernelIdentifier)

			if (kernelId === undefined) {
				console.warn(`[KernelRegistry] No pre-assigned ID found for kernel module "${moduleName}". Skipping.`)
				continue
			}

			// Find the primary exported function.
			// Convention 1: The export name matches the camelCased file name.
			let kernelFn = module[kernelIdentifier]
			let found = typeof kernelFn === 'function'
			let actualKernelName = kernelIdentifier

			// Convention 2 (Fallback): If not found, and there's only one function export, use that.
			if (!found) {
				const exports = Object.keys(module).filter(key => typeof module[key] === 'function')
				if (exports.length === 1) {
					actualKernelName = exports[0]
					kernelFn = module[actualKernelName]
					found = true
				}
			}

			if (found && !this.kernelToId.has(kernelFn)) {
				this.kernelToId.set(kernelFn, kernelId)
				this.idToKernel.set(kernelId, kernelFn)
				// Store the *actual* exported function name for the worker to look up.
				this.kernelMetadata.set(kernelId, { name: actualKernelName, moduleName: moduleName })
			} else if (!found) {
				console.warn(
					`[KernelRegistry] Could not find a single exported kernel function in module "${moduleName}". Expected an export named "${kernelIdentifier}" or a single function export.`,
				)
			}
		}
	}

	/**
	 * Creates a proxy that allows accessing kernel IDs by name even before they are fully registered.
	 * This solves the initialization order problem where a system module needs a kernel ID
	 * before the kernel registry has been populated.
	 * e.g., `const { myKernel } = ecs.getKernelIDs()`
	 * @private
	 */
	setKernelIdObject(idObject) {
		this._kernelIdObject = Object.freeze(idObject)
	}

	getKernelIds() {
		return this._kernelIdObject
	}

	getAllKernelCode() {
		return this.kernelCode
	}

	getKernelMetadata() {
		return this.kernelMetadata
	}

	/**
	 * Resolves a kernel handle (Symbol or function reference) to its numeric ID.
	 * @param {Symbol | Function} handle The kernel handle.
	 * @returns {number | undefined} The numeric ID or undefined if not found.
	 */
	getKernelId(handle) {
		// This is now much simpler. We only need to resolve the function reference.
		// Symbols are no longer used.
		if (typeof handle === 'function') return this.kernelToId.get(handle)
		// If a raw number is passed, just return it.
		if (typeof handle === 'number') return handle
		return undefined // Or handle error for invalid type
	}
	/**
	 * Clears all registered kernels.
	 */
	clear() {
		this.kernelToId.clear()
		this.idToKernel.clear()
		this.kernelNameToId.clear()
		this.kernelMetadata.clear()
		this.kernelCode = {}
		this.nextKernelId = 1
		this._kernelIdObject = null
	}

	/**
	 * Assigns an ID to a kernel name. Called by SystemManager during Phase 1.
	 * @param {string} kernelName
	 */
	assignKernelId(kernelName) {
		if (!this.kernelNameToId.has(kernelName)) {
			const id = this.nextKernelId++
			this.kernelNameToId.set(kernelName, id)
		}
	}
}

export const kernelRegistry = new KernelRegistry()
