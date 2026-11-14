import { describe, expect, it, vi } from 'vitest'
import { RelayApiError, RelayClient, type RelayS2StateRequest } from './relayClient'

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

const approvedState: RelayS2StateRequest = { month: '2026-12', planVersion: 1, planConfirmed: true, docVersion: 1, basedOnPlanVersion: 1, approved: true }

describe('RelayClient POST /local/s2-state', () => {
  const echo = (body: RelayS2StateRequest) => ({ ...body, approvalSource: 'local-client-attestation' })

  it('토큰과 JSON 본문을 보내고 월·버전·플래그 외의 필드는 보내지 않는다', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(echo(approvedState)))
    const client = new RelayClient({ fetcher })
    client.configure('http://127.0.0.1:3000', 'local-secret')
    await expect(client.syncS2State({ ...approvedState, studentName: '민감' } as RelayS2StateRequest)).resolves.toMatchObject({ approvalSource: 'local-client-attestation' })
    const [url, init] = fetcher.mock.calls[0]!
    const headers = new Headers(init?.headers)
    expect(url).toBe('http://127.0.0.1:3000/local/s2-state')
    expect(init?.method).toBe('POST')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Authorization')).toBe('Bearer local-secret')
    expect(JSON.parse(String(init?.body))).toEqual(approvedState)
    expect(String(init?.body)).not.toContain('local-secret')
  })

  it('토큰이 없으면 요청하지 않고, 백엔드 불변식을 어기면 전송 전에 거부한다', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = new RelayClient({ fetcher })
    await expect(client.syncS2State(approvedState)).rejects.toMatchObject({ kind: 'configuration' })
    client.configure('http://127.0.0.1:3000', 'token')
    for (const bad of [
      { ...approvedState, planVersion: 0, basedOnPlanVersion: 0 },
      { ...approvedState, month: '2026-13' },
      { ...approvedState, planConfirmed: false },
      { ...approvedState, planVersion: 2 },
      { ...approvedState, basedOnPlanVersion: 2, approved: false },
      { ...approvedState, docVersion: 1.5 },
    ]) await expect(client.syncS2State(bad)).rejects.toMatchObject({ kind: 'configuration' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    [400, 'INVALID_REQUEST', 'validation'], [401, 'UNAUTHORIZED', 'authentication'], [403, 'ORIGIN_NOT_ALLOWED', 'forbidden'],
    [409, 'VERSION_REGRESSION', 'conflict'], [429, 'RELAY_BUSY', 'rate_limited'], [503, 'STATE_UNAVAILABLE', 'server'],
  ])('HTTP %i를 %s 코드와 함께 %s로 분류한다', async (status, code, kind) => {
    const client = new RelayClient({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: code }, status)) })
    client.configure('http://127.0.0.1:3000', 'token')
    await expect(client.syncS2State(approvedState)).rejects.toMatchObject({ kind, status, code })
  })

  it('네트워크 오류, 타임아웃, 잘못된 응답을 구분한다', async () => {
    const offline = new RelayClient({ fetcher: vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')) })
    offline.configure('http://127.0.0.1:3000', 'token')
    await expect(offline.syncS2State(approvedState)).rejects.toMatchObject({ kind: 'network_or_cors' })

    const hanging: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
    const slow = new RelayClient({ fetcher: hanging, timeoutMs: 10 })
    slow.configure('http://127.0.0.1:3000', 'token')
    await expect(slow.syncS2State(approvedState)).rejects.toMatchObject({ kind: 'timeout' })

    const invalid = new RelayClient({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ month: '2026-12' })) })
    invalid.configure('http://127.0.0.1:3000', 'token')
    await expect(invalid.syncS2State(approvedState)).rejects.toMatchObject({ kind: 'invalid_response' })
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
