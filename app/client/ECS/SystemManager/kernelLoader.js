/**
 * Provides a utility for dynamically loading kernel modules.
 */

/**
 * Dynamically loads kernel modules by fetching the kernel tree from the main process
 * and then importing them.
 * This utility is used by the SystemManager to load all available kernels and their source code.
 * @returns {Promise<{loadedModules: Map<string, object>, kernelCode: object}>} A promise that resolves to an object containing the loaded modules and their source code.
 */
export async function loadAllKernels(kernelFiles) {
	const loadedModules = new Map()
	const kernelCode = {}

	for (const fileName of kernelFiles) {
		const modulePath = `${PATH_KERNELS}/${fileName}`
		const module = await import(modulePath)
		const moduleNameWithoutExt = fileName.replace('.js', '')
		loadedModules.set(moduleNameWithoutExt, module)

		// Reverting to electronAPI to investigate potential race conditions.
		const code = await window.electronAPI.getKernelSource(fileName)
		if (code) kernelCode[moduleNameWithoutExt] = code
	}
	return { loadedModules, kernelCode }
}