import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BabmuwonDatabase, type Substitution } from '../../data'
import { RelayApiError, type RelayAiResponse, type RelayHealth, type RelaySubstituteEvidenceRequest } from '../relay/relayClient'
import { SubstitutionEvidenceService, type EvidenceClient } from './substitutionEvidence'

const at = '2026-11-15T00:00:00.000Z'
const response = (overrides: Partial<RelayAiResponse> = {}): RelayAiResponse => ({
  text: '[모의 초안] 대체 식품 참고 정보', citations: [], simulated: true, cached: false, reviewRequired: true, sourceMissing: true, source: 'mock', ...overrides,
})

class FakeClient implements EvidenceClient {
  token = true
  linerMode: RelayHealth['linerMode'] = 'mock'
  failure?: Error
  response = response()
  calls: RelaySubstituteEvidenceRequest[] = []
  hasToken() { return this.token }
  async health(): Promise<RelayHealth> { return { status: 'ok', service: 'mawd-relay', linerMode: this.linerMode, channelMode: 'mock', localOnly: true } }
  async substituteEvidence(input: RelaySubstituteEvidenceRequest) { this.calls.push(input); if (this.failure) throw this.failure; return this.response }
}

describe('대체식 참고 근거 조회 (Mock Relay)', () => {
  let database: BabmuwonDatabase
  let client: FakeClient
  let service: SubstitutionEvidenceService
  let substitution: Substitution

  beforeEach(async () => {
    database = new BabmuwonDatabase(`evidence-${crypto.randomUUID()}`)
    await database.open()
    client = new FakeClient()
    service = new SubstitutionEvidenceService(database, client)
    await database.substituteMenus.add({ id: 'seed', name: '두부조림', slot: '주찬', allergenStatus: 'listed', allergenNos: [5], energy: 100, protein: 8 })
    await database.mealEntries.add({ id: 'e1', mealPlanId: 'p', date: '2026-12-01', slot: '국', menuName: '미역국', allergenStatus: 'none_confirmed', allergenNos: [], statusSource: 'manual', statusSetAt: at })
    await database.students.add({ id: 's1', grade: 1, class: 2, number: 3, alias: '구름-27', realName: '홍길동', needsSubstitute: true, memo: '', createdAt: at, updatedAt: at })
    substitution = { id: 'sub', conflictId: 'c', checkedProcessed: false, status: 'pending', basedOn: { planVersion: 1, studentVersion: 1 }, createdAt: at, updatedAt: at }
    await database.substitutions.add(substitution)
  })
  afterEach(async () => { database.close(); await database.delete() })

  it('후보 식품명과 알레르기 번호만 보내고 결과·상태 플래그를 로컬에 저장한다', async () => {
    const result = await service.fetchEvidence('두부조림', 1)
    expect(client.calls).toEqual([{ allergenNo: 1, foodName: '두부조림' }])
    expect(result.response).toMatchObject({ simulated: true, sourceMissing: true, reviewRequired: true })
    expect(await service.getStored('두부조림', 1)).toMatchObject({ foodName: '두부조림', allergenNo: 1, response: { text: '[모의 초안] 대체 식품 참고 정보' } })
    expect(await service.getStored('두부조림', 2)).toBeUndefined()
    expect((await database.apiCallLogs.toArray()).map((log) => [log.endpoint, log.status, log.allowedFields])).toEqual([
      ['/ai/substitute-evidence', 'ok', { allergenNo: 1, foodName: '두부조림' }],
    ])
  })

  it('출처가 있는 응답은 그대로 보존한다', async () => {
    client.response = response({ citations: [{ title: '근거', url: 'https://example.invalid/e' }], sourceMissing: false, simulated: false, source: 'search' })
    const result = await service.fetchEvidence('미역국', 5)
    expect(result.response.citations).toEqual([{ title: '근거', url: 'https://example.invalid/e' }])
    expect((await service.getStored('미역국', 5))?.response.source).toBe('search')
  })

  it('조회 결과는 대체식 확정 상태·학생·충돌 데이터를 바꾸지 않는다', async () => {
    const before = JSON.stringify([await database.substitutions.toArray(), await database.students.toArray(), await database.conflicts.toArray(), await database.dataVersions.toArray()])
    await service.fetchEvidence('두부조림', 5)
    expect(JSON.stringify([await database.substitutions.toArray(), await database.students.toArray(), await database.conflicts.toArray(), await database.dataVersions.toArray()])).toBe(before)
    expect((await database.substitutions.get('sub'))?.status).toBe('pending')
  })

  it('식단·후보 목록에 없거나 개인정보로 의심되는 값, 잘못된 번호는 요청 전에 차단하고 값을 기록하지 않는다', async () => {
    await database.mealEntries.add({ id: 'leak', mealPlanId: 'p', date: '2026-12-02', slot: '부찬', menuName: '홍길동 반찬', allergenStatus: 'none_confirmed', allergenNos: [], statusSource: 'manual', statusSetAt: at })
    await expect(service.fetchEvidence('목록에 없는 임의 문장', 1)).rejects.toThrow('개인정보')
    await expect(service.fetchEvidence('홍길동 반찬', 1)).rejects.toThrow('개인정보')
    await expect(service.fetchEvidence('두부조림', 0 as never)).rejects.toThrow('알레르기 번호')
    await expect(service.fetchEvidence('두부조림', 20 as never)).rejects.toThrow('알레르기 번호')
    expect(client.calls).toHaveLength(0)
    const logs = await database.apiCallLogs.toArray()
    expect(logs.every((log) => log.status === 'blocked' && Object.keys(log.allowedFields).length === 0)).toBe(true)
    expect(JSON.stringify(logs)).not.toContain('홍길동')
    expect(await database.apiCache.count()).toBe(0)
  })

  it('live·비활성 Liner와 Relay 미연결에서는 요청하지 않는다', async () => {
    client.linerMode = 'live'
    await expect(service.fetchEvidence('두부조림', 1)).rejects.toThrow('live')
    client.linerMode = 'disabled'
    await expect(service.fetchEvidence('두부조림', 1)).rejects.toThrow('비활성')
    client.linerMode = 'mock'; client.token = false
    await expect(service.fetchEvidence('두부조림', 1)).rejects.toThrow('연결되어 있지 않습니다')
    expect(client.calls).toHaveLength(0)
  })

  it('Relay 오류·시간 초과에서는 저장하지 않고 오류를 기록한다', async () => {
    client.failure = new RelayApiError('timeout', '시간 초과')
    await expect(service.fetchEvidence('두부조림', 1)).rejects.toMatchObject({ kind: 'timeout' })
    client.failure = new RelayApiError('rate_limited', '혼잡', { status: 429, code: 'RELAY_BUSY' })
    await expect(service.fetchEvidence('두부조림', 1)).rejects.toMatchObject({ code: 'RELAY_BUSY' })
    expect(await database.apiCache.count()).toBe(0)
    expect((await database.apiCallLogs.toArray()).map((log) => log.status)).toEqual(['error', 'error'])
  })
})
