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

const aiBody = { text: '[모의 초안] 이달의 소식', citations: [], simulated: true, cached: false, reviewRequired: true, sourceMissing: true, source: 'mock' }

describe('RelayClient POST /ai/*', () => {
  const connect = (fetcher: typeof fetch, timeoutMs?: number) => {
    const client = new RelayClient({ fetcher, timeoutMs })
    client.configure('http://127.0.0.1:3000', 'local-secret')
    return client
  }

  it('s2-news는 월과 메뉴명만, nutrition은 주제 ID만 JSON으로 보낸다', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(aiBody))
    const client = connect(fetcher)
    await expect(client.s2News({ month: '2026-12', menus: ['닭갈비', '미역국'], studentName: '민감' } as never)).resolves.toMatchObject({ simulated: true, sourceMissing: true, source: 'mock' })
    await client.nutrition({ topicId: 'balanced_meals' })
    expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:3000/ai/s2-news')
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ month: '2026-12', menus: ['닭갈비', '미역국'] })
    expect(fetcher.mock.calls[1]![0]).toBe('http://127.0.0.1:3000/ai/nutrition')
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({ topicId: 'balanced_meals' })
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get('Authorization')).toBe('Bearer local-secret')
  })

  it('잘못된 요청은 전송 전에 거부하고 토큰이 없으면 요청하지 않는다', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = connect(fetcher)
    for (const bad of [
      { month: '2026-13', menus: ['a'] }, { month: '2026-12', menus: [] }, { month: '2026-12', menus: ['a', 'b', 'c', 'd'] },
      { month: '2026-12', menus: ['  '] }, { month: '2026-12', menus: ['가'.repeat(201)] },
    ]) await expect(client.s2News(bad)).rejects.toMatchObject({ kind: 'validation' })
    await expect(client.nutrition({ topicId: 'free_text' as never })).rejects.toMatchObject({ kind: 'validation' })
    expect(fetcher).not.toHaveBeenCalled()
    await expect(new RelayClient({ fetcher }).nutrition({ topicId: 'food_waste' })).rejects.toMatchObject({ kind: 'configuration' })
  })

  it.each([
    [400, 'BLOCKED_BY_PRIVACY_POLICY', 'validation'], [401, 'UNAUTHORIZED', 'authentication'], [403, 'ORIGIN_NOT_ALLOWED', 'forbidden'],
    [409, 'S2_NOT_CURRENT_APPROVED', 'conflict'], [429, 'RELAY_BUSY', 'rate_limited'], [504, 'LINER_TIMEOUT', 'server'],
  ])('HTTP %i(%s)를 %s로 분류한다', async (status, code, kind) => {
    const client = connect(vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ error: code }, status)))
    await expect(client.s2News({ month: '2026-12', menus: ['닭갈비'] })).rejects.toMatchObject({ kind, status, code })
  })

  it('AI 호출은 일반 요청보다 긴 대기 시간을 쓰고, 네트워크 오류·잘못된 응답을 구분한다', async () => {
    const slow: typeof fetch = (_url, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(jsonResponse(aiBody)), 60)
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')) })
    })
    const client = connect(slow, 10)
    await expect(client.s2News({ month: '2026-12', menus: ['닭갈비'] })).resolves.toMatchObject({ text: aiBody.text })
    await expect(client.health()).rejects.toMatchObject({ kind: 'timeout' })

    const offline = connect(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(offline.nutrition({ topicId: 'food_waste' })).rejects.toMatchObject({ kind: 'network_or_cors' })
    for (const bad of [{ ...aiBody, text: '' }, { ...aiBody, simulated: 'yes' }, { ...aiBody, source: 'other' },
      { ...aiBody, citations: [{ title: 'x', url: 'javascript:alert(1)' }] }, { text: 'only text' }]) {
      const invalid = connect(vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(bad)))
      await expect(invalid.nutrition({ topicId: 'food_waste' })).rejects.toMatchObject({ kind: 'invalid_response' })
    }
  })

  it('http(s) 출처가 있는 응답을 그대로 전달한다', async () => {
    const body = { ...aiBody, simulated: false, sourceMissing: false, source: 'search', citations: [{ title: '식약처', url: 'https://example.invalid/a' }] }
    const client = connect(vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(body)))
    await expect(client.nutrition({ topicId: 'food_allergy_basics' })).resolves.toMatchObject({ citations: body.citations, source: 'search' })
  })
})

describe('RelayClient POST /ai/substitute-evidence, /ai/s5-body', () => {
  const connect = (fetcher: typeof fetch) => { const client = new RelayClient({ fetcher }); client.configure('http://127.0.0.1:3000', 'local-secret'); return client }
  const ok = () => vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(aiBody))
  const counts = { byAllergen: [{ allergenNo: 1, students: 5 }, { allergenNo: 2, students: '3명 미만' as const }], byGrade: [{ grade: 1, students: '3명 미만' as const }], provided: 12, excluded: '3명 미만' as const }

  it('substitute-evidence는 알레르기 번호와 식품명만 보낸다', async () => {
    const fetcher = ok()
    await expect(connect(fetcher).substituteEvidence({ allergenNo: 1, foodName: '두부조림', studentId: 's1' } as never)).resolves.toMatchObject({ simulated: true })
    expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:3000/ai/substitute-evidence')
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ allergenNo: 1, foodName: '두부조림' })
  })

  it('substitute-evidence 요청 형식 오류는 전송 전에 거부한다', async () => {
    const fetcher = ok(); const client = connect(fetcher)
    for (const bad of [{ allergenNo: 0, foodName: 'a' }, { allergenNo: 20, foodName: 'a' }, { allergenNo: 1.5, foodName: 'a' }, { allergenNo: 1, foodName: ' ' }, { allergenNo: 1, foodName: '가'.repeat(201) }]) {
      await expect(client.substituteEvidence(bad)).rejects.toMatchObject({ kind: 'validation' })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('s5-body는 counts만 보내고 허용되지 않은 필드는 복사하지 않는다', async () => {
    const fetcher = ok()
    await connect(fetcher).s5Body({ counts, totalStudents: 99, students: [{ alias: '구름-01' }] } as never)
    expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:3000/ai/s5-body')
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ counts })
    expect(String(fetcher.mock.calls[0]![1]?.body)).not.toContain('구름')
  })

  it('s5-body는 0~2 같은 소수 집계와 중복·범위 오류를 전송 전에 거부한다', async () => {
    const fetcher = ok(); const client = connect(fetcher)
    const bad = [
      { ...counts, provided: 2 }, { ...counts, excluded: 0 }, { ...counts, provided: 1.5 }, { ...counts, provided: '2명' },
      { ...counts, byAllergen: [{ allergenNo: 1, students: 1 }] }, { ...counts, byGrade: [{ grade: 1, students: 0 }] },
      { ...counts, byAllergen: [{ allergenNo: 1, students: 5 }, { allergenNo: 1, students: 6 }] }, { ...counts, byAllergen: [{ allergenNo: 20, students: 5 }] },
      { ...counts, byGrade: [{ grade: 7, students: 5 }] }, { ...counts, provided: 100_001 },
    ]
    for (const value of bad) await expect(client.s5Body({ counts: value as never })).rejects.toMatchObject({ kind: 'validation' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([[400, 'BLOCKED_BY_PRIVACY_POLICY', 'validation'], [401, 'UNAUTHORIZED', 'authentication'], [403, 'HOST_NOT_ALLOWED', 'forbidden'], [429, 'RELAY_BUSY', 'rate_limited'], [504, 'LINER_TIMEOUT', 'server']])(
    '두 엔드포인트 모두 HTTP %i를 %s → %s로 분류한다', async (status, code, kind) => {
      const client = connect(vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ error: code }, status)))
      await expect(client.s5Body({ counts })).rejects.toMatchObject({ kind, status, code })
      await expect(client.substituteEvidence({ allergenNo: 1, foodName: '두부조림' })).rejects.toMatchObject({ kind, status, code })
    })
})

describe('RelayClient GET /audit', () => {
  it('인증 헤더로 기록을 받고 형식이 다르면 거부한다', async () => {
    const events = [{ at: '2026-11-15T00:00:00.000Z', endpoint: '/ai/s2-news', status: 'ok', statusCode: 200, durationMs: 3 }]
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ events })).mockResolvedValueOnce(jsonResponse({ events: [{ at: 1 }] }))
    const client = new RelayClient({ fetcher })
    await expect(client.audit()).rejects.toMatchObject({ kind: 'configuration' })
    client.configure('http://127.0.0.1:3000', 'token')
    await expect(client.audit()).resolves.toEqual(events)
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('Authorization')).toBe('Bearer token')
    await expect(client.audit()).rejects.toMatchObject({ kind: 'invalid_response' })
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
