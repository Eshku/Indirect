// This script acts as a bridge between Electron's IPC and the client-side event bus.
// It should have no knowledge of specific managers like SystemManager.
import { eventEmitter } from '../client/Core/Classes/EventEmitter.js';


	window.electronAPI.onHmrUpdate((data) => {
		switch (data.type) {
			case 'system-update':
				// Emit a global event instead of calling a manager directly.
				eventEmitter.emit('hmr:system-update', data);
				break;
			case 'schedule-update':
				eventEmitter.emit('hmr:schedule-update', data);
				break;
			case 'reload':
				// Full page reloads are a global concern, so handling it here is acceptable.
				console.log('[HMR Renderer] Received reload signal. Reloading page...');
				window.location.reload();
				break;
		}
	});
