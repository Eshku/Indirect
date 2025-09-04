window.PATH_ROOT = await window.electronAPI.getRootDirectory()

window.PATH_CLIENT = `${window.PATH_ROOT}/client`
window.PATH_ASSETS = `${window.PATH_CLIENT}/assets`

window.PATH_COMPONENTS = `${window.PATH_CLIENT}/Components`
window.PATH_SYSTEMS = `${window.PATH_CLIENT}/Systems`
window.PATH_MANAGERS = `${window.PATH_CLIENT}/Managers`

window.PATH_ARCHETYPES = `${window.PATH_CLIENT}/Archetypes`
window.PATH_PREFABS = `${window.PATH_CLIENT}/Prefabs`


window.PATH_ICONS = `${window.PATH_ASSETS}/icons`

window.PATH_CORE = `${window.PATH_CLIENT}/Core`

window.PATH_UI = `${window.PATH_CLIENT}/UI`

window.PATH_SERVICES = `${window.PATH_CLIENT}/Services`

window.PATH_TESTS = `${window.PATH_CLIENT}/Tests`
