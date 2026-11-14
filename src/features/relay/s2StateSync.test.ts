import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BabmuwonDatabase, MealRepository, VersionRepository, type GeneratedDoc, type MealPlan, type YearMonth } from '../../data'
import { DocumentService, type S2Document } from '../documents'
import { RelayApiError, type RelayS2StateRequest, type RelayS2StateResponse } from './relayClient'
import { S2StateSyncService, type S2StateClient } from './s2StateSync'

const at = '2026-11-15T00:00:00.000Z'

/** 백엔드 setDocument/validateDocument 규칙을 흉내 내는 가짜 Relay. */
class FakeRelay implements S2StateClient {
  token = true
  failure?: RelayApiError
  calls: RelayS2StateRequest[] = []
  stored = new Map<string, RelayS2StateRequest>()
  beforeRespond?: () => Promise<void>
  hasToken() { return this.token }
  async syncS2State(input: RelayS2StateRequest): Promise<RelayS2StateResponse> {
    this.calls.push(structuredClone(input))
    if (this.failure) throw this.failure
    await this.beforeRespond?.()
    const old = this.stored.get(input.month)
    if (old && (input.planVersion < old.planVersion || input.docVersion < old.docVersion)) throw new RelayApiError('conflict', 'x', { status: 409, code: 'VERSION_REGRESSION' })
    if (old && old.docVersion === input.docVersion && old.basedOnPlanVersion !== input.basedOnPlanVersion) throw new RelayApiError('conflict', 'x', { status: 409, code: 'NEW_DOCUMENT_VERSION_REQUIRED' })
    this.stored.set(input.month, input)
    return { ...input, approvalSource: 'local-client-attestation' }
  }
  callsFor(month: string) { return this.calls.filter((call) => call.month === month) }
}

describe('S2 승인 상태 Relay 동기화', () => {
  let database: BabmuwonDatabase
  let documents: DocumentService
  let relay: FakeRelay
  let sync: S2StateSyncService

  beforeEach(async () => {
    database = new BabmuwonDatabase(`s2-sync-${crypto.randomUUID()}`)
    await database.open()
    documents = new DocumentService(database)
    relay = new FakeRelay()
    sync = new S2StateSyncService(database, relay)
  })
  afterEach(async () => { database.close(); await database.delete() })

  it('승인 후 동기화에 성공하면 synced가 되고 월·버전·플래그만 전송한다', async () => {
    const doc = await approvedS2('2026-12')
    expect(doc.s2DeliveryState).toBe('sync_required')
    expect((await sync.checkSendEligibility(doc.id)).eligible).toBe(false)

    const outcome = await sync.syncMonth('2026-12')
    expect(outcome.status).toBe('synced')
    expect(relay.calls).toEqual([{ month: '2026-12', planVersion: 1, planConfirmed: true, docVersion: 1, basedOnPlanVersion: 1, approved: true }])
    expect((await database.generatedDocs.get(doc.id))?.s2DeliveryState).toBe('synced')
    expect(await sync.checkSendEligibility(doc.id)).toEqual({ eligible: true })
  })

  it('동기화 실패와 서버 연결 끊김에서는 sync_failed로 남아 발송할 수 없고, 재연결 후 복구된다', async () => {
    const doc = await approvedS2('2026-12')
    relay.failure = new RelayApiError('network_or_cors', '연결 끊김')
    const failed = await sync.syncMonth('2026-12')
    expect(failed.status).toBe('failed')
    expect((await database.generatedDocs.get(doc.id))?.s2DeliveryState).toBe('sync_failed')
    expect(await sync.checkSendEligibility(doc.id)).toMatchObject({ eligible: false, reason: expect.stringContaining('실패') })

    relay.failure = undefined
    const [recovered] = await sync.syncAll({ force: true })
    expect(recovered?.status).toBe('synced')
    expect((await sync.checkSendEligibility(doc.id)).eligible).toBe(true)
  })

  it('Relay 토큰이 없으면 요청 없이 not_connected이고 상태를 바꾸지 않는다', async () => {
    const doc = await approvedS2('2026-12')
    relay.token = false
    expect((await sync.syncMonth('2026-12')).status).toBe('not_connected')
    expect(relay.calls).toHaveLength(0)
    expect((await database.generatedDocs.get(doc.id))?.s2DeliveryState).toBe('sync_required')
    expect((await sync.checkSendEligibility(doc.id)).eligible).toBe(false)
  })

  it('새로고침 후 새 Relay(빈 상태)에 연결하면 이미 synced였던 승인본도 다시 보고한다', async () => {
    const doc = await approvedS2('2026-12')
    await sync.syncMonth('2026-12')
    const restarted = new FakeRelay()
    const reconnected = new S2StateSyncService(database, restarted)
    expect((await reconnected.syncMonth('2026-12')).status).toBe('skipped')
    expect((await reconnected.syncAll({ force: true }))[0]?.status).toBe('synced')
    expect(restarted.calls).toHaveLength(1)
    expect((await reconnected.checkSendEligibility(doc.id)).eligible).toBe(true)
  })

  it('식단이 다시 확정되면 기존 S2가 무효화되고 승인 해제 상태가 보고되며 새 버전만 다시 발송 가능해진다', async () => {
    const first = await approvedS2('2026-12')
    await sync.syncMonth('2026-12')
    await new MealRepository(database).confirm('plan-2026-12', at)

    const stale = await database.generatedDocs.get(first.id)
    expect(stale).toMatchObject({ status: 'stale', s2DeliveryState: 'sync_required' })
    expect(await sync.checkSendEligibility(first.id)).toMatchObject({ eligible: false })

    expect((await sync.syncMonth('2026-12')).status).toBe('synced')
    expect(relay.calls.at(-1)).toEqual({ month: '2026-12', planVersion: 2, planConfirmed: true, docVersion: 1, basedOnPlanVersion: 1, approved: false })
    expect(await sync.checkSendEligibility(first.id)).toMatchObject({ eligible: false })

    const second = await approvedS2('2026-12', false)
    expect(second).toMatchObject({ docVersion: 2 })
    await sync.syncMonth('2026-12')
    expect(relay.calls.at(-1)).toEqual({ month: '2026-12', planVersion: 2, planConfirmed: true, docVersion: 2, basedOnPlanVersion: 2, approved: true })
    expect((await sync.checkSendEligibility(second.id)).eligible).toBe(true)
    expect(await sync.checkSendEligibility(first.id)).toMatchObject({ eligible: false })
  })

  it('다른 월의 S2는 영향받지 않고 해당 월만 Relay에 보고된다', async () => {
    const november = await approvedS2('2026-11')
    const december = await approvedS2('2026-12')
    await sync.syncAll()
    relay.calls = []
    await new MealRepository(database).confirm('plan-2026-12', at)
    await sync.syncMonth('2026-12')

    expect((await database.generatedDocs.get(november.id))).toMatchObject({ status: 'approved', s2DeliveryState: 'synced' })
    expect((await database.generatedDocs.get(december.id))?.status).toBe('stale')
    expect(relay.callsFor('2026-11')).toHaveLength(0)
    expect(relay.callsFor('2026-12')).toHaveLength(1)
    expect((await sync.checkSendEligibility(november.id)).eligible).toBe(true)
    // 11월 상태는 그대로이므로 재연결 force 동기화도 12월의 실패와 무관하게 동작한다.
    relay.failure = new RelayApiError('server', '장애', { status: 500 })
    const outcomes = await sync.syncAll({ force: true })
    expect(outcomes.map((item) => item.status)).toEqual(['failed', 'failed'])
  })

  it('다른 월의 식단 확정은 이 월의 승인본과 보고 버전을 바꾸지 않는다', async () => {
    const november = await approvedS2('2026-11')
    await seedPlan('2026-12') // 전역 planVersion이 올라간다
    await new MealRepository(database).confirm('plan-2026-12', at)
    await sync.syncMonth('2026-11')
    expect(relay.calls[0]).toMatchObject({ month: '2026-11', planVersion: 1, basedOnPlanVersion: 1, approved: true })
    expect((await sync.checkSendEligibility(november.id)).eligible).toBe(true)
  })

  it('식단 확정을 해제하면 승인본이 무효화되고 planConfirmed=false로 보고한다', async () => {
    const doc = await approvedS2('2026-12')
    await sync.syncMonth('2026-12')
    await new MealRepository(database).unconfirm('plan-2026-12')
    expect((await database.generatedDocs.get(doc.id))).toMatchObject({ status: 'stale', s2DeliveryState: 'sync_required' })
    await sync.syncMonth('2026-12')
    expect(relay.calls.at(-1)).toMatchObject({ planConfirmed: false, approved: false, docVersion: 1, basedOnPlanVersion: 1 })
    expect((await sync.checkSendEligibility(doc.id)).eligible).toBe(false)
  })

  it('재확정 없이 식단 데이터가 바뀌면 발송 직전 검사에서 stale로 바뀌고 재동기화가 무효 상태를 보고한다', async () => {
    const doc = await approvedS2('2026-12')
    await sync.syncMonth('2026-12')
    await database.mealEntries.update('plan-2026-12-entry', { menuName: '바뀐 메뉴' })

    expect(await sync.checkSendEligibility(doc.id)).toMatchObject({ eligible: false, reason: expect.stringContaining('변경') })
    expect((await database.generatedDocs.get(doc.id))).toMatchObject({ status: 'stale', s2DeliveryState: 'sync_required' })
    await sync.syncMonth('2026-12')
    expect(relay.calls.at(-1)).toMatchObject({ approved: false })
  })

  it('syncMonth가 승인본을 보내기 전에 stale을 감지하면 승인 상태를 보고하지 않는다', async () => {
    await approvedS2('2026-12')
    await database.mealEntries.update('plan-2026-12-entry', { menuName: '바뀐 메뉴' })
    await sync.syncMonth('2026-12')
    expect(relay.calls).toHaveLength(1)
    expect(relay.calls[0]).toMatchObject({ approved: false })
  })

  it('요청 중 문서가 바뀌면 그 응답으로 synced 처리하지 않고 최신 상태를 다시 보고한다', async () => {
    const doc = await approvedS2('2026-12')
    let first = true
    relay.beforeRespond = async () => {
      if (!first) return
      first = false
      await new MealRepository(database).unconfirm('plan-2026-12')
    }
    const outcome = await sync.syncMonth('2026-12')
    expect(outcome.status).toBe('synced')
    expect(relay.calls.map((call) => call.approved)).toEqual([true, false])
    expect((await database.generatedDocs.get(doc.id))?.status).toBe('stale')
    expect((await sync.checkSendEligibility(doc.id)).eligible).toBe(false)
  })

  it('Relay가 버전 회귀 409를 반환하면 sync_failed로 남아 발송이 차단된다', async () => {
    const doc = await approvedS2('2026-12')
    relay.stored.set('2026-12', { month: '2026-12', planVersion: 9, planConfirmed: true, docVersion: 5, basedOnPlanVersion: 9, approved: false })
    const outcome = await sync.syncMonth('2026-12')
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'VERSION_REGRESSION' })
    expect((await sync.checkSendEligibility(doc.id)).eligible).toBe(false)
  })

  it('stale 문서는 synced 상태여도 발송할 수 없다', async () => {
    const doc = await approvedS2('2026-12')
    await sync.syncMonth('2026-12')
    await database.generatedDocs.put({ ...(await database.generatedDocs.get(doc.id))!, status: 'stale', staleReason: '테스트 stale' })
    expect(await sync.checkSendEligibility(doc.id)).toEqual({ eligible: false, reason: '테스트 stale' })
  })

  it('한 번도 보고하지 않은 S2 초안은 Relay로 보내지 않는다', async () => {
    await seedPlan('2026-12')
    await documents.generateS2('2026-12')
    expect((await sync.syncMonth('2026-12')).status).toBe('skipped')
    expect(relay.calls).toHaveLength(0)
  })

  /** 확정 식단을 준비하고 S2를 생성·승인한다. AI 문구 단계는 아직 없으므로 슬롯을 승인 상태로 채운다. */
  async function approvedS2(month: YearMonth, seed = true): Promise<GeneratedDoc> {
    if (seed) await seedPlan(month)
    const generated = await documents.generateS2(month)
    const content = generated.content as S2Document
    await database.generatedDocs.put({
      ...generated,
      content: { ...content, narrativeSlots: content.narrativeSlots.map((slot) => ({ ...slot, state: 'approved', text: '직접 입력한 안내 문구' })) },
    })
    return documents.approve(generated.id)
  }

  async function seedPlan(month: YearMonth) {
    const id = `plan-${month}`
    const plan: MealPlan = { id, yearMonth: month, status: 'confirmed', confirmedAt: at, sourceFile: 'virtual.xlsx', unknownCount: 0, createdAt: at, updatedAt: at }
    await database.mealPlans.put(plan)
    await database.mealEntries.put({ id: `${id}-entry`, mealPlanId: id, date: `${month}-01`, slot: '주찬', menuName: '가상 메뉴', allergenStatus: 'none_confirmed', allergenNos: [], statusSource: 'manual', statusSetAt: at })
    await new VersionRepository(database).bump('planVersion')
  }
})
