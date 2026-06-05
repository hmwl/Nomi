import { afterEach, describe, expect, it, vi } from 'vitest'
import { toBackendRuntimeValue, toWebRuntimeValue } from './webBridge'

describe('web runtime asset URL mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps nomi-local asset URLs to HTTP asset URLs recursively', () => {
    expect(toWebRuntimeValue({
      url: 'nomi-local://asset/project%201/assets/generated/a%20b.png',
      nested: ['nomi-local://asset/project-2/assets/video.webm'],
    })).toEqual({
      url: '/api/assets/file/project%201/assets/generated/a%20b.png',
      nested: ['/api/assets/file/project-2/assets/video.webm'],
    })
  })

  it('maps HTTP asset URLs back to nomi-local before persisting to backend', () => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:5173' } })
    expect(toBackendRuntimeValue({
      url: '/api/assets/file/project%201/assets/generated/a%20b.png',
    })).toEqual({
      url: 'nomi-local://asset/project%201/assets/generated/a%20b.png',
    })
  })
})

