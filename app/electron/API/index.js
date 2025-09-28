const { initPaths } = require('./pathsAPI')
const { initAppInfo } = require('./appInfoAPI')
const { initDevTools } = require('./devToolsAPI')
const { initUserDataDirectory, initFileSystem } = require('./fileSystemAPI')
const { initPrefabAPI } = require('./prefabAPI')
const { initComponentAPI } = require('./componentAPI')
const { initSystemAPI } = require('./systemAPI')
const { initManagerAPI } = require('./managerAPI')

module.exports = {
	initPaths,
	initAppInfo,
	initDevTools,
	initUserDataDirectory,
	initFileSystem,
	initPrefabAPI,
	initComponentAPI,
	initSystemAPI,
	initManagerAPI,
}
