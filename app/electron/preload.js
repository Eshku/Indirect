const { contextBridge, ipcRenderer } = require('electron')

/**
 * Securely exposes a controlled set of APIs from the main process to the renderer process.
 * This follows Electron's security best practices by using `contextBridge` and avoiding
 * direct exposure of `ipcRenderer` or other Node.js modules.
 */
contextBridge.exposeInMainWorld('electronAPI', {
	// Prefab & Data Loading 
	getPrefabData: prefabPath => ipcRenderer.invoke('get-prefab-data', prefabPath),
	getPrefabManifest: () => ipcRenderer.invoke('get-prefab-manifest'),

	// Filesystem & Metadata 
	getRootDirectory: () => ipcRenderer.invoke('get-root-directory'),
	getEnv: () => ipcRenderer.invoke('get-env'),
	saveFile: (filePath, data) => ipcRenderer.invoke('save-file', filePath, data),
	getComponentTree: () => ipcRenderer.invoke('get-component-tree'),
	getSystemTree: () => ipcRenderer.invoke('get-system-tree'),
	getManagerTree: () => ipcRenderer.invoke('get-manager-tree'),

	// Workers 
	getWorkerCode: relativeWorkerPath => ipcRenderer.invoke('get-worker-code', relativeWorkerPath),

	// Dev Tools 
	toggleDevTools: () => ipcRenderer.send('toggle-dev-tools'),
})