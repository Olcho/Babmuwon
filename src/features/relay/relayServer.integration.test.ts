import { describe, expect, it } from 'vitest'
import { RelayClient } from './relayClient'

/**
 * 실제 로컬 Relay 서버(LINER_MODE=mock)를 대상으로 하는 통합 테스트. 기본 `npm test`에서는 건너뛴다.
 *   RELAY_TEST_URL=http://127.0.0.1:3917 RELAY_TEST_TOKEN=<토큰> npx vitest run src/features/relay/relayServer.integration.test.ts
 * 실제 외부 Liner·채널톡에는 연결하지 않는다(서버가 mock 모드여야 한다).
 */
const url = process.env.RELAY_TEST_URL
const token = process.env.RELAY_TEST_TOKEN ?? ''

describe.skipIf(!url)('실제 Relay 서버(mock 모드) 통합', () => {
  const client = new RelayClient({ baseUrl: url, timeoutMs: 10_000 })
  client.configure(url ?? 'http://127.0.0.1:3000', token)

  it('health가 mock 모드이고 인증된 catalog가 응답한다', async () => {
    expect((await client.health()).linerMode).toBe('mock')
    expect((await client.catalog()).topics).toHaveProperty('balanced_meals')
  })

  it('/ai/s2-news는 모의 초안과 상태 플래그를 반환한다', async () => {
    const response = await client.s2News({ month: '2026-12', menus: ['닭갈비', '미역국'] })
    expect(response).toMatchObject({ simulated: true, reviewRequired: true, sourceMissing: true, source: 'mock' })
    expect(response.text.length).toBeGreaterThan(0)
  })

  it('/ai/nutrition은 모의 초안을 반환하고 같은 요청은 캐시된다', async () => {
    const first = await client.nutrition({ topicId: 'seasonal_foods' })
    const second = await client.nutrition({ topicId: 'seasonal_foods' })
    expect(first).toMatchObject({ simulated: true, source: 'mock' })
    expect(second.cached).toBe(true)
  })

  it('잘못된 토큰은 401, 알 수 없는 필드는 서버가 400으로 거부한다', async () => {
    const wrong = new RelayClient({ baseUrl: url })
    wrong.configure(url ?? 'http://127.0.0.1:3000', 'wrong-token-wrong-token-wrong-token-00')
    await expect(wrong.nutrition({ topicId: 'food_waste' })).rejects.toMatchObject({ kind: 'authentication', status: 401 })
    const response = await fetch(`${url}/ai/nutrition`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: 'food_waste', prompt: '자유 텍스트' }),
    })
    expect(response.status).toBe(400)
  })

  it('/local/s2-state 동기화와 버전 회귀 409', async () => {
    const month = '2027-03'
    const base = { month, planVersion: 2, planConfirmed: true, docVersion: 2, basedOnPlanVersion: 2, approved: true }
    await expect(client.syncS2State(base)).resolves.toMatchObject({ approvalSource: 'local-client-attestation' })
    await expect(client.syncS2State({ ...base, planVersion: 1, docVersion: 1, basedOnPlanVersion: 1 })).rejects.toMatchObject({ kind: 'conflict', code: 'VERSION_REGRESSION' })
  })

  it('서버는 메뉴명 내용을 검사하지 않는다(FE 로컬 검사가 유일한 방어선임을 확인)', async () => {
    const response = await client.s2News({ month: '2026-12', menus: ['1학년 2반 3번 홍길동 010-1234-5678'] })
    expect(response.simulated).toBe(true)
  })
})
