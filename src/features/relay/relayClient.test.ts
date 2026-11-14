import { describe, expect, it, vi } from 'vitest'
import { RelayApiError, RelayClient } from './relayClient'

const health = { status: 'ok', service: 'mawd-relay', linerMode: 'mock', channelMode: 'mock', localOnly: true }
const catalog = { foods: ['가상메뉴'], topics: { balanced_meals: '균형 잡힌 식사' }, templateCode: 'demo', templateText: '#{월}월 안내' }

describe('RelayClient', () => {
  it('/health에는 토큰을 보내지 않고 /catalog에만 Bearer 토큰을 보낸다', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(health))
      .mockResolvedValueOnce(jsonResponse(catalog))
    const client = new RelayClient({ fetcher })
    client.configure('http://127.0.0.1:3000/', ' local-secret ')
    await expect(client.health()).resolves.toEqual(health)
    await expect(client.catalog()).resolves.toEqual(catalog)
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).has('Authorization')).toBe(false)
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get('Authorization')).toBe('Bearer local-secret')
    expect(fetcher.mock.calls[1]![0]).toBe('http://127.0.0.1:3000/catalog')
  })

  it('토큰 미입력과 401 인증 오류를 구분한다', async () => {
    const client = new RelayClient({ fetcher: vi.fn<typeof fetch>() })
    await expect(client.catalog()).rejects.toMatchObject({ kind: 'configuration' })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: 'UNAUTHORIZED' }, 401))
    const authenticated = new RelayClient({ fetcher })
    authenticated.configure('http://127.0.0.1:3000', 'wrong')
    await expect(authenticated.catalog()).rejects.toMatchObject({ kind: 'authentication', status: 401, code: 'UNAUTHORIZED' })
  })

  it('CORS 또는 네트워크 실패, 서버 오류, 잘못된 응답을 분류한다', async () => {
    const offline = new RelayClient({ fetcher: vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')) })
    await expect(offline.health()).rejects.toMatchObject({ kind: 'network_or_cors' })
    const server = new RelayClient({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: 'INTERNAL_ERROR' }, 500)) })
    await expect(server.health()).rejects.toMatchObject({ kind: 'server', status: 500 })
    const invalid = new RelayClient({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: 'ok' })) })
    await expect(invalid.health()).rejects.toMatchObject({ kind: 'invalid_response' })
  })

  it('토큰은 메모리에서 명시적으로 제거할 수 있다', () => {
    const client = new RelayClient()
    client.configure('http://127.0.0.1:3000', 'secret')
    expect(client.hasToken()).toBe(true)
    client.clearToken()
    expect(client.hasToken()).toBe(false)
  })

  it('잘못된 서버 주소를 요청 전에 차단한다', () => {
    const client = new RelayClient()
    expect(() => client.configure('file:///tmp/relay', 'secret')).toThrow(RelayApiError)
    expect(() => client.configure('http://user:password@localhost:3000', 'secret')).toThrow('http 또는 https')
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
