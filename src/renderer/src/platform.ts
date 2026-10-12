// The one place the UI gets its platform API from. On the desktop that's the object
// the preload script exposed; a browser build would plug in its own implementation here.

import type { FreeswapAPI } from '@shared/api'

export const api: FreeswapAPI = window.freeswap
