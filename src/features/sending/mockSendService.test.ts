import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BabmuwonDatabase, MealRepository, VersionRepository, type GeneratedDoc, type MealPlan, type YearMonth } from '../../data'
import { DocumentService } from '../documents/documentService'
import type { S2Document } from '../documents/documentModels'
import { S2StateSyncService } from '../relay/s2StateSync'
import { MOCK_INTERRUPTED_CODE, MockSendError, MockSendService, batchKeyOf, maskPhone, mockAlimtalkText, normalizePhone } from './mockSendService'

const at = '2026-11-15T00:00:00.000Z'

describe('Mock 학부모 발송 시뮬레이션', () => {
  let database: BabmuwonDatabase
  let documents: DocumentService
  let service: MockSendService
  let fetchSpy: ReturnType<typeof vi.spyOn>
  let guardianIds: string[]

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Mock 발송은 네트워크를 쓰면 안 됩니다'))
    database = new BabmuwonDatabase(`mock-send-${crypto.randomUUID()}`)
    await database.open()
    documents = new DocumentService(database)
    service = new MockSendService(database)
    guardianIds = (await service.addDemoGuardians()).map((guardian) => guardian.id)
  })
  afterEach(async () => {
    expect(fetchSpy).not.toHaveBeenCalled() // 어떤 경우에도 실제 API(채널톡·Relay)를 부르지 않는다
    fetchSpy.mockRestore()
    database.close(); await database.delete()
  })

  it('승인된 최신 S2를 가상 보호자에게 Mock 발송하고 결과·이력을 IndexedDB에 저장한다', async () => {
    const doc = await approvedS2('2026-12')
    const progress = vi.fn()
    const view = await service.simulate(doc.id, guardianIds, { onProgress: progress })

    expect(view.batch).toMatchObject({ batchKey: '2026-12:doc-v1:mock-lunch-notice', simulated: true, status: 'requested', docVersion: 1 })
    expect(view.totals).toEqual({ count: 3, pending: 0, requested: 3, failed: 0, delivered: 0 })
    expect(view.recipients.every(({ recipient }) => recipient.requestStatus === 'requested' && recipient.deliveryStatus === 'unknown' && recipient.attempts?.length === 1)).toBe(true)
    expect(view.recipients.map((item) => item.maskedPhone)).toEqual(['010-****-0001', '010-****-0002', '010-****-0003'])
    expect(progress).toHaveBeenCalled()
    expect(await database.sendBatches.count()).toBe(1)
    expect(await database.sendRecipients.count()).toBe(3)
    // Mock 시연은 문서 상태·Relay 동기화 상태를 바꾸지 않는다
    expect(await database.generatedDocs.get(doc.id)).toMatchObject({ status: 'approved', s2DeliveryState: 'sync_required' })
  })

  it('이력은 새 서비스 인스턴스(새로고침)에서도 유지된다', async () => {
    const doc = await approvedS2('2026-12')
    await service.simulate(doc.id, guardianIds.slice(0, 2))
    const history = await new MockSendService(database).listHistory()
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ month: '2026-12', totals: { count: 2, requested: 2 }, correctionNeeded: false })
  })

  it('Mock은 Relay 동기화 없이 로컬 검증만으로 가능하고, 실제 발송 경로는 여전히 Relay 동기화를 요구한다', async () => {
    const doc = await approvedS2('2026-12')
    expect((await service.checkEligibility(doc.id)).eligible).toBe(true)
    const relay = new S2StateSyncService(database, { hasToken: () => false, syncS2State: vi.fn() })
    expect(await relay.checkSendEligibility(doc.id)).toMatchObject({ eligible: false, reason: expect.stringContaining('동기화') })
  })

  it('미승인 S2는 차단한다', async () => {
    await seedPlan('2026-12')
    const draft = await documents.generateS2('2026-12')
    await expect(service.simulate(draft.id, guardianIds)).rejects.toThrow('승인된 S2만')
    expect(await database.sendBatches.count()).toBe(0)
  })

  it('AI 문구가 검토·승인되지 않은 S2는 승인본으로 취급하지 않는다', async () => {
    const doc = await approvedS2('2026-12')
    const content = doc.content as S2Document
    await database.generatedDocs.put({ ...doc, content: { ...content, narrativeSlots: content.narrativeSlots.map((slot, index) => index === 0 ? { ...slot, state: 'draft' as const } : slot) } })
    await expect(service.simulate(doc.id, guardianIds)).rejects.toThrow('문구')
  })

  it('식단 재확정으로 stale이 된 S2는 차단하고, 다른 월 S2는 그대로 발송 가능하다', async () => {
    const november = await approvedS2('2026-11')
    const december = await approvedS2('2026-12')
    await new MealRepository(database).confirm('plan-2026-12', at)
    await expect(service.simulate(december.id, guardianIds)).rejects.toThrow('재검토')
    expect((await database.generatedDocs.get(november.id))?.status).toBe('approved')
    await expect(service.simulate(november.id, guardianIds)).resolves.toMatchObject({ batch: { status: 'requested' } })
  })

  it('승인 후 식단 데이터가 바뀌면 발송 직전 재검증에서 차단하고 그 월의 문서만 stale로 바꾼다', async () => {
    const november = await approvedS2('2026-11')
    const december = await approvedS2('2026-12')
    await database.mealEntries.update('plan-2026-12-entry', { menuName: '바뀐 메뉴' })
    await expect(service.simulate(december.id, guardianIds)).rejects.toThrow('기준 데이터가 변경')
    expect((await database.generatedDocs.get(december.id))?.status).toBe('stale')
    expect((await database.generatedDocs.get(november.id))?.status).toBe('approved')
    expect((await service.checkEligibility(november.id)).eligible).toBe(true)
  })

  it('학생·대체식 데이터 변경은 S2 승인(식단 기준)을 무효화하지 않는다', async () => {
    const doc = await approvedS2('2026-12')
    await database.students.add({ id: 'new', grade: 1, class: 1, number: 1, alias: '별빛-11', needsSubstitute: true, memo: '', createdAt: at, updatedAt: at })
    await new VersionRepository(database).bump('studentVersion')
    await new VersionRepository(database).bump('substitutionVersion')
    expect((await service.checkEligibility(doc.id)).eligible).toBe(true)
  })

  it('같은 월에 더 최신 S2 버전이 있으면 이전 승인본은 차단한다', async () => {
    const first = await approvedS2('2026-12')
    await documents.generateS2('2026-12')
    await expect(service.simulate(first.id, guardianIds)).rejects.toThrow('더 최신 S2')
  })

  it('같은 S2 버전의 중복 시뮬레이션과 더블클릭을 막는다', async () => {
    const doc = await approvedS2('2026-12')
    const results = await Promise.allSettled([service.simulate(doc.id, guardianIds), service.simulate(doc.id, guardianIds)])
    expect(results.map((item) => item.status).sort()).toEqual(['fulfilled', 'rejected'])
    await expect(service.simulate(doc.id, guardianIds)).rejects.toBeInstanceOf(MockSendError)
    await expect(new MockSendService(database).simulate(doc.id, guardianIds)).rejects.toThrow('이미 Mock 발송한 기록')
    expect(await database.sendBatches.count()).toBe(1)
    expect(await service.findBatchForDoc(doc.id)).toMatchObject({ batchKey: batchKeyOf(doc) })
  })

  it('가상 실패는 partial로 기록하고 실패 건만 재시도하며 모든 시도 이력을 보존한다', async () => {
    const doc = await approvedS2('2026-12')
    const failing = guardianIds[0]!
    const first = await service.simulate(doc.id, guardianIds, { failGuardianIds: [failing] })
    expect(first.batch.status).toBe('partial')
    expect(first.totals).toMatchObject({ requested: 2, failed: 1 })
    const failed = first.recipients.find((item) => item.recipient.guardianId === failing)!
    const succeeded = first.recipients.find((item) => item.recipient.guardianId !== failing)!
    expect(failed.retryable).toBe(true)
    await expect(service.retry(first.batch.id, [succeeded.recipient.id])).rejects.toThrow('실패한 수신자만')

    const retried = await service.retry(first.batch.id, [failed.recipient.id])
    const after = retried.recipients.find((item) => item.recipient.id === failed.recipient.id)!.recipient
    expect(retried.batch.status).toBe('requested')
    expect(after).toMatchObject({ requestStatus: 'requested', retryCount: 1, errorCode: undefined })
    expect(after.attempts?.map((attempt) => attempt.result)).toEqual(['request_failed', 'requested'])
    expect(await database.sendBatches.count()).toBe(1)
  })

  it('가상 재시도는 수신자당 최대 3회까지만 허용한다', async () => {
    const doc = await approvedS2('2026-12')
    const failing = [guardianIds[0]!]
    const view = await service.simulate(doc.id, failing, { failGuardianIds: failing })
    const id = view.recipients[0]!.recipient.id
    for (let index = 0; index < 3; index += 1) await service.retry(view.batch.id, [id], { failGuardianIds: failing })
    const final = (await service.listHistory())[0]!.recipients[0]!
    expect(final).toMatchObject({ retryable: false, recipient: { retryCount: 3 } })
    expect(final.recipient.attempts).toHaveLength(4)
    await expect(service.retry(view.batch.id, [id])).rejects.toThrow('최대 3회')
  })

  it('발송 후 S2가 무효화되면 재시도를 막고 이력에 정정 안내 필요를 표시한다', async () => {
    const doc = await approvedS2('2026-12')
    const view = await service.simulate(doc.id, guardianIds, { failGuardianIds: [guardianIds[0]!] })
    await new MealRepository(database).confirm('plan-2026-12', at)
    const failed = view.recipients.find((item) => item.recipient.requestStatus === 'request_failed')!
    await expect(service.retry(view.batch.id, [failed.recipient.id])).rejects.toThrow('재시도할 수 없습니다')
    const history = (await service.listHistory())[0]!
    expect(history).toMatchObject({ correctionNeeded: true })
    expect(history.recipients.every((item) => !item.retryable)).toBe(true)
  })

  it('중단된 시뮬레이션(대기로 남은 수신자)은 이력 조회 시 가상 실패로 정리해 재시도할 수 있게 한다', async () => {
    const doc = await approvedS2('2026-12')
    await database.sendBatches.add({ id: 'b', batchKey: batchKeyOf(doc), docId: doc.id, docVersion: 1, templateCode: 'mock-lunch-notice', status: 'requesting', createdAt: at, simulated: true })
    await database.sendRecipients.add({ id: 'r', batchId: 'b', guardianId: guardianIds[0]!, requestStatus: 'pending', deliveryStatus: 'unknown', retryCount: 0, attempts: [] })
    const [view] = await service.listHistory()
    expect(view?.batch.status).toBe('partial')
    expect(view?.recipients[0]).toMatchObject({ retryable: true, recipient: { requestStatus: 'request_failed', errorCode: MOCK_INTERRUPTED_CODE } })
  })

  it('가상 도착 확인은 Mock 요청 성공 건에만 수동으로 기록한다', async () => {
    const doc = await approvedS2('2026-12')
    const view = await service.simulate(doc.id, guardianIds, { failGuardianIds: [guardianIds[0]!] })
    const ok = view.recipients.find((item) => item.recipient.requestStatus === 'requested')!
    const failed = view.recipients.find((item) => item.recipient.requestStatus === 'request_failed')!
    await service.markDelivery(ok.recipient.id, 'delivered')
    expect(await database.sendRecipients.get(ok.recipient.id)).toMatchObject({ deliveryStatus: 'delivered', deliveryCheckedBy: 'manual' })
    await expect(service.markDelivery(failed.recipient.id, 'delivered')).rejects.toThrow('성공한 수신자만')
  })

  it('대상 선택 검증: 빈 선택, 10명 초과, 삭제된 보호자', async () => {
    const doc = await approvedS2('2026-12')
    await expect(service.simulate(doc.id, [])).rejects.toThrow('선택')
    await expect(service.simulate(doc.id, Array.from({ length: 11 }, (_, index) => `g${index}`))).rejects.toThrow('최대 10명')
    await service.removeGuardian(guardianIds[0]!)
    await expect(service.simulate(doc.id, guardianIds)).rejects.toThrow('삭제')
    expect(await database.sendBatches.count()).toBe(0)
  })

  it('가상 보호자: 번호 형식 검사·정규화, 중복 차단, 무작위 memberId, 예시 추가는 중복 없이', async () => {
    expect(normalizePhone('01012345678')).toBe('010-1234-5678')
    expect(() => normalizePhone('02-123-4567')).toThrow('형식')
    await expect(service.addGuardian({ label: '가상 D', phone: '010-0000-0001' })).rejects.toThrow('이미 등록')
    await expect(service.addGuardian({ label: ' ', phone: '010-0000-0009' })).rejects.toThrow('표시명')
    const added = await service.addGuardian({ label: '가상 D', phone: '01000000009' })
    expect(added).toMatchObject({ phone: '010-0000-0009' })
    expect(added.channelMemberId).toMatch(/^[0-9a-f-]{36}$/)
    expect(await service.addDemoGuardians()).toEqual([])
    expect(await database.guardians.count()).toBe(4)
    expect(maskPhone('010-1234-5678')).toBe('010-****-5678')
    expect(mockAlimtalkText('2026-12', '가상학교')).toBe('[가상학교] 12월 급식 안내입니다. 이달 식단과 알레르기 표시는 아래 버튼에서 확인해 주세요.')
  })

  async function approvedS2(month: YearMonth): Promise<GeneratedDoc> {
    await seedPlan(month)
    const generated = await documents.generateS2(month)
    const content = generated.content as S2Document
    await database.generatedDocs.put({ ...generated, content: { ...content, narrativeSlots: content.narrativeSlots.map((slot) => ({ ...slot, state: 'approved' as const, text: '직접 입력한 문구' })) } })
    return documents.approve(generated.id)
  }

  async function seedPlan(month: YearMonth) {
    const id = `plan-${month}`
    if (await database.mealPlans.get(id)) return
    const plan: MealPlan = { id, yearMonth: month, status: 'confirmed', confirmedAt: at, sourceFile: 'virtual.xlsx', unknownCount: 0, createdAt: at, updatedAt: at }
    await database.mealPlans.put(plan)
    await database.mealEntries.put({ id: `${id}-entry`, mealPlanId: id, date: `${month}-01`, slot: '주찬', menuName: '가상 메뉴', allergenStatus: 'none_confirmed', allergenNos: [], statusSource: 'manual', statusSetAt: at })
    await new VersionRepository(database).bump('planVersion')
  }
})
