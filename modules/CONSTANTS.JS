window.PATH_ROOT = await window.electronAPI.getRootDirectory()

window.PATH_ASSETS = `${window.PATH_ROOT}/assets`
window.PATH_MODULES = `${window.PATH_ROOT}/modules`

window.PATH_COMPONENTS = `${window.PATH_MODULES}/Components`
window.PATH_SYSTEMS = `${window.PATH_MODULES}/Systems`
window.PATH_MANAGERS = `${window.PATH_MODULES}/Managers`

window.PATH_ARCHETYPES = `${window.PATH_MODULES}/Archetypes`
window.PATH_PREFABS = `${window.PATH_MODULES}/Prefabs`

window.PATH_NODE_MODULES = `${window.PATH_ROOT}/node_modules`

window.PATH_ICONS = `${window.PATH_ASSETS}/icons`

window.PATH_CORE = `${window.PATH_MODULES}/Core`

window.PATH_UI = `${window.PATH_MODULES}/UI`

window.PATH_SERVICES = `${window.PATH_MODULES}/Services`

window.PATH_TESTS = `${window.PATH_MODULES}/Tests`
