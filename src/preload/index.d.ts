import type { FreeswapAPI } from '../shared/api'

declare global {
  interface Window {
    freeswap: FreeswapAPI
  }
}

export {}
