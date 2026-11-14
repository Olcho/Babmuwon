import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BabmuwonDatabase, VersionRepository, type MealPlan, type YearMonth } from '../../data'
import { RelayApiError, type RelayAiResponse, type RelayHealth } from '../relay/relayClient'
import { DocumentService } from './documentService'
import { reportBodyText } from './documentBuilders'
import { createDocumentWorkbook } from './documentExporters'
import type { S2Document, S5Document } from './documentModels'
import { NarrativeError, NarrativeService, type NarrativeClient } from './narrative'

const at = '2026-11-15T00:00:00.000Z'
const aiResponse = (overrides: Partial<RelayAiResponse> = {}): RelayAiResponse => ({
  text: '[모의 초안] 12월 급식 소식', citations: [], simulated: true, cached: false, reviewRequired: true, sourceMissing: true, source: 'mock', ...overrides,
})

/** 실제 네트워크를 쓰지 않는 Mock Relay 클라이언트. */
class FakeClient implements NarrativeClient {
  token = true
  linerMode: RelayHealth['linerMode'] = 'mock'
  failure?: Error
  response = aiResponse()
  newsCalls: unknown[] = []
  nutritionCalls: unknown[] = []
  hasToken() { return this.token }
  async health(): Promise<RelayHealth> { return { status: 'ok', service: 'mawd-relay', linerMode: this.linerMode, channelMode: 'mock', localOnly: true } }
  async s2News(input: unknown) { this.newsCalls.push(input); if (this.failure) throw this.failure; return this.response }
  async nutrition(input: unknown) { this.nutritionCalls.push(input); if (this.failure) throw this.failure; return this.response }
  s5Calls: unknown[] = []
  async s5Body(input: unknown) { this.s5Calls.push(input); if (this.failure) throw this.failure; return this.response }
}

describe('S2 AI 문구 생성·검토 (Mock Relay)', () => {
  let database: BabmuwonDatabase
  let documents: DocumentService
  let client: FakeClient
  let narrative: NarrativeService
  let docId: string

  beforeEach(async () => {
    database = new BabmuwonDatabase(`s2-narrative-${crypto.randomUUID()}`)
    await database.open()
    documents = new DocumentService(database)
    client = new FakeClient()
    narrative = new NarrativeService(database, client)
    await seedPlan('2026-12')
    await database.students.add({ id: 's1', grade: 1, class: 2, number: 3, alias: '구름-27', realName: '홍길동', needsSubstitute: true, memo: '', createdAt: at, updatedAt: at })
    await database.schools.add({ id: 'school', name: '가상초등학교', principal: 'P', manager: 'M', phone: '02-000-0000', headcount: 1 })
    docId = (await documents.generateS2('2026-12')).id
  })
  afterEach(async () => { database.close(); await database.delete() })

  const slots = async () => ((await database.generatedDocs.get(docId))!.content as S2Document).narrativeSlots
  const allChecked = { sourceChecked: true, noMedicalClaim: true, factsChecked: true }

  it('요청에는 월과 공개 메뉴명만 담기고, 응답은 승인되지 않은 초안으로 저장된다', async () => {
    const draft = await narrative.generateNews(docId, ['닭갈비', '미역국'])
    expect(client.newsCalls).toEqual([{ month: '2026-12', menus: ['닭갈비', '미역국'] }])
    expect(draft).toMatchObject({ source: 'router', approved: false, edited: false, reviewChecklist: { sourceChecked: false, noMedicalClaim: false, factsChecked: false }, meta: { simulated: true, sourceMissing: true, reviewRequired: true } })
    expect((await slots())[0]).toMatchObject({ key: 'monthlyNews', state: 'draft', simulated: true, sourceMissing: true, text: draft.text })
    await expect(documents.approve(docId)).rejects.toThrow('생성·검토되지 않아')
  })

  it('reviewRequired=false 응답이어도 자동 승인하지 않고 검토를 요구한다', async () => {
    client.response = aiResponse({ reviewRequired: false, simulated: false, sourceMissing: false, source: 'router' })
    const draft = await narrative.generateNews(docId, ['닭갈비'])
    expect(draft).toMatchObject({ approved: false, meta: { reviewRequired: true, simulated: false } })
    await expect(narrative.approveText(docId, 'monthlyNews')).rejects.toThrow('검토 항목')
  })

  it('영양 정보는 주제 ID만 보내고 출처를 저장한다', async () => {
    client.response = aiResponse({ citations: [{ title: '출처', url: 'https://example.invalid/n' }], sourceMissing: false, source: 'search' })
    const draft = await narrative.generateNutrition(docId, 'food_waste')
    expect(client.nutritionCalls).toEqual([{ topicId: 'food_waste' }])
    expect(draft).toMatchObject({ source: 'liner', citations: [{ title: '출처', url: 'https://example.invalid/n' }] })
    expect((await slots())[1]).toMatchObject({ key: 'nutritionEducation', state: 'draft', citations: [{ url: 'https://example.invalid/n' }] })
  })

  it('검토 체크 3개와 명시적 승인 후에만 문서에 반영되고 S2 승인이 가능해진다', async () => {
    await narrative.generateNews(docId, ['닭갈비'])
    await narrative.generateNutrition(docId, 'balanced_meals')
    await expect(narrative.approveText(docId, 'monthlyNews')).rejects.toThrow('출처 확인')
    await narrative.setChecklist(docId, 'monthlyNews', { ...allChecked, factsChecked: false })
    await expect(narrative.approveText(docId, 'monthlyNews')).rejects.toThrow('숫자·메뉴명 확인')
    await narrative.setChecklist(docId, 'monthlyNews', allChecked)
    await narrative.approveText(docId, 'monthlyNews')
    expect((await slots())[0]?.state).toBe('approved')
    await expect(documents.approve(docId)).rejects.toThrow('생성·검토되지 않아')
    await narrative.setChecklist(docId, 'nutritionEducation', allChecked)
    await narrative.approveText(docId, 'nutritionEducation')
    await expect(documents.approve(docId)).resolves.toMatchObject({ status: 'approved', s2DeliveryState: 'sync_required' })
  })

  it('문구를 수정하면 검토 체크와 승인이 초기화되고 수정 여부가 기록된다', async () => {
    await narrative.generateNews(docId, ['닭갈비'])
    await narrative.setChecklist(docId, 'monthlyNews', allChecked)
    await narrative.approveText(docId, 'monthlyNews')
    const edited = await narrative.saveText(docId, 'monthlyNews', '  직접 고친 문구  ')
    expect(edited).toMatchObject({ text: '직접 고친 문구', edited: true, approved: false, source: 'router', reviewChecklist: { sourceChecked: false } })
    expect((await slots())[0]?.state).toBe('draft')
    await expect(narrative.approveText(docId, 'monthlyNews')).rejects.toThrow('검토 항목')
    await expect(narrative.saveText(docId, 'monthlyNews', '   ')).rejects.toThrow('문구를 입력')
  })

  it('AI 실패·Relay 미연결에서는 기존 초안을 바꾸지 않고 직접 입력·기본 문구로 승인할 수 있다', async () => {
    client.failure = new RelayApiError('timeout', '시간 초과')
    await expect(narrative.generateNews(docId, ['닭갈비'])).rejects.toMatchObject({ kind: 'timeout' })
    expect((await slots())[0]?.state).toBe('not_generated')
    client.failure = new RelayApiError('rate_limited', '혼잡', { status: 429, code: 'RELAY_BUSY' })
    await expect(narrative.generateNutrition(docId, 'food_waste')).rejects.toMatchObject({ code: 'RELAY_BUSY' })
    client.token = false
    await expect(narrative.generateNews(docId, ['닭갈비'])).rejects.toThrow('연결되어 있지 않습니다')

    const manual = await narrative.saveText(docId, 'monthlyNews', '12월 급식 안내입니다.')
    expect(manual.source).toBe('manual')
    await narrative.approveText(docId, 'monthlyNews') // 직접 입력은 AI 검토 체크가 필요 없다
    const template = await narrative.useTemplate(docId, 'nutritionEducation')
    expect(template.source).toBe('template')
    await narrative.approveText(docId, 'nutritionEducation')
    await expect(documents.approve(docId)).resolves.toMatchObject({ status: 'approved' })
  })

  it('live Liner 모드와 비활성 모드에서는 요청을 보내지 않는다', async () => {
    client.linerMode = 'live'
    await expect(narrative.generateNews(docId, ['닭갈비'])).rejects.toThrow('live')
    client.linerMode = 'disabled'
    await expect(narrative.generateNutrition(docId, 'food_waste')).rejects.toThrow('비활성')
    expect(client.newsCalls).toHaveLength(0)
    expect(client.nutritionCalls).toHaveLength(0)
    expect((await database.apiCallLogs.toArray()).map((log) => log.status)).toEqual(['blocked', 'blocked'])
  })

  it('개인정보 의심 값·식단에 없는 값은 요청 전에 차단하고 기록에 값을 남기지 않는다', async () => {
    await database.mealEntries.add({ id: 'leak', mealPlanId: 'plan-2026-12', date: '2026-12-02', slot: '부찬', menuName: '홍길동 반찬', allergenStatus: 'none_confirmed', allergenNos: [], statusSource: 'manual', statusSetAt: at })
    await expect(narrative.generateNews(docId, ['홍길동 반찬'])).rejects.toThrow('개인정보')
    await expect(narrative.generateNews(docId, ['식단에 없는 값'])).rejects.toThrow('개인정보')
    expect(client.newsCalls).toHaveLength(0)
    const logs = await database.apiCallLogs.toArray()
    expect(logs.every((log) => log.status === 'blocked' && Object.keys(log.allowedFields).length === 0)).toBe(true)
    expect(JSON.stringify(logs)).not.toContain('홍길동')
  })

  it('성공·실패 호출은 허용 필드만 기록한다', async () => {
    await narrative.generateNews(docId, ['닭갈비'])
    client.failure = new Error('x')
    await expect(narrative.generateNutrition(docId, 'food_waste')).rejects.toThrow()
    const logs = (await database.apiCallLogs.toArray()).sort((a, b) => a.endpoint.localeCompare(b.endpoint)) // 키가 UUID라 저장 순서가 보장되지 않는다
    expect(logs.map((log) => [log.endpoint, log.status, log.allowedFields])).toEqual([
      ['/ai/nutrition', 'error', { topicId: 'food_waste' }], ['/ai/s2-news', 'ok', { month: '2026-12', menus: ['닭갈비'] }],
    ])
  })

  it('승인·재검토 상태의 S2는 문구를 수정할 수 없다', async () => {
    await narrative.saveText(docId, 'monthlyNews', '소식')
    await narrative.approveText(docId, 'monthlyNews')
    await narrative.useTemplate(docId, 'nutritionEducation')
    await narrative.approveText(docId, 'nutritionEducation')
    await documents.approve(docId)
    await expect(narrative.saveText(docId, 'monthlyNews', '바꾸기')).rejects.toBeInstanceOf(NarrativeError)
    await expect(narrative.generateNews(docId, ['닭갈비'])).rejects.toBeInstanceOf(NarrativeError)
  })

  it('대표 메뉴 후보는 확정 식단의 메뉴명에서만 나온다', async () => {
    const { all, suggested } = await narrative.listMenuCandidates(docId)
    expect([...all].sort()).toEqual(['귤', '닭갈비', '미역국'])
    expect(suggested).toHaveLength(3)
    expect(suggested[0]).toBe('닭갈비') // 주찬 슬롯 우선
  })

  async function seedPlan(month: YearMonth) {
    const id = `plan-${month}`
    const plan: MealPlan = { id, yearMonth: month, status: 'confirmed', confirmedAt: at, sourceFile: 'virtual.xlsx', unknownCount: 0, createdAt: at, updatedAt: at }
    await database.mealPlans.put(plan)
    const entry = (n: number, slot: string, menuName: string) => ({ id: `${id}-${n}-${slot}`, mealPlanId: id, date: `${month}-0${n}`, slot, menuName, allergenStatus: 'none_confirmed' as const, allergenNos: [], statusSource: 'manual' as const, statusSetAt: at })
    await database.mealEntries.bulkPut([entry(1, '주찬', '닭갈비'), entry(1, '국', '미역국'), entry(1, '후식', '귤')])
    await new VersionRepository(database).bump('planVersion')
  }
})

describe('S5 AI 본문 생성·검토 (Mock Relay)', () => {
  let database: BabmuwonDatabase
  let documents: DocumentService
  let client: FakeClient
  let narrative: NarrativeService
  let docId: string
  const allChecked = { sourceChecked: true, noMedicalClaim: true, factsChecked: true }

  beforeEach(async () => {
    database = new BabmuwonDatabase(`s5-narrative-${crypto.randomUUID()}`)
    await database.open()
    documents = new DocumentService(database)
    client = new FakeClient()
    narrative = new NarrativeService(database, client)
    for (const n of [1, 2, 3, 4]) {
      await database.students.add({ id: `s${n}`, grade: n === 4 ? 2 : 1, class: 1, number: n, alias: `구름-0${n}`, realName: `실명${n}`, needsSubstitute: true, memo: '', createdAt: at, updatedAt: at })
      await database.studentAllergies.add({ id: `a${n}`, studentId: `s${n}`, allergenNo: n === 4 ? 5 : 1 })
    }
    docId = (await documents.generateS5('2026')).id
  })
  afterEach(async () => { database.close(); await database.delete() })

  const artifact = async () => (await database.generatedDocs.get(docId))!.content as S5Document

  it('비식별 집계만 전송하고 로컬 통계·표는 정확한 값을 유지한다', async () => {
    const draft = await narrative.generateS5Body(docId)
    const request = client.s5Calls[0] as { counts: { byAllergen: { allergenNo: number; students: unknown }[]; byGrade: unknown[]; provided: unknown; excluded: unknown } }
    expect(Object.keys(request)).toEqual(['counts'])
    expect(request.counts.byAllergen.find((item) => item.allergenNo === 1)?.students).toBe(3)
    expect(request.counts.byAllergen.find((item) => item.allergenNo === 5)?.students).toBe('3명 미만')
    expect(request.counts.byGrade).toEqual([{ grade: 1, students: 3 }, { grade: 2, students: '3명 미만' }])
    for (const forbidden of ['구름', '실명', 's1', 'totalStudents']) expect(JSON.stringify(request)).not.toContain(forbidden)
    expect((await artifact()).byAllergen.find((item) => item.allergenNo === 5)?.students).toBe(1)
    expect(draft).toMatchObject({ docType: 'S5', field: 'annualReportBody', source: 'router', approved: false, meta: { simulated: true, sourceMissing: true, reviewRequired: true } })
    expect((await database.apiCallLogs.toArray())[0]).toMatchObject({ endpoint: '/ai/s5-body', status: 'ok' })
  })

  it('AI 초안은 승인 전까지 보고서 본문에 반영되지 않고 승인 후에만 반영된다', async () => {
    await narrative.generateS5Body(docId)
    expect(reportBodyText(await artifact())).toBe((await artifact()).reportText)
    await expect(documents.approve(docId)).rejects.toThrow('검토 중인 보고 본문')
    await expect(narrative.approveText(docId, 'annualReportBody')).rejects.toThrow('검토 항목')
    await narrative.saveText(docId, 'annualReportBody', '수정한 보고 본문')
    await narrative.setChecklist(docId, 'annualReportBody', allChecked)
    expect(reportBodyText(await artifact())).toBe((await artifact()).reportText)
    await narrative.approveText(docId, 'annualReportBody')
    expect(reportBodyText(await artifact())).toBe('수정한 보고 본문')
    expect(createDocumentWorkbook(await artifact()).Sheets['운영 보고']?.B1?.v).toBe('수정한 보고 본문')
    await expect(documents.approve(docId)).resolves.toMatchObject({ status: 'approved' })
  })

  it('AI 본문을 쓰지 않아도 로컬 기본 문구로 S5를 승인할 수 있고, 실패해도 초안은 바뀌지 않는다', async () => {
    client.failure = new RelayApiError('server', '장애', { status: 503, code: 'LINER_RATE_LIMITED' })
    await expect(narrative.generateS5Body(docId)).rejects.toMatchObject({ code: 'LINER_RATE_LIMITED' })
    expect((await artifact()).narrativeSlots?.[0]?.state).toBe('not_generated')
    await expect(documents.approve(docId)).resolves.toMatchObject({ status: 'approved' })
  })

  it('기본 문구 되돌리기는 로컬 보고 문구를 넣고 직접 승인한다', async () => {
    await narrative.generateS5Body(docId)
    const template = await narrative.useTemplate(docId, 'annualReportBody')
    expect(template).toMatchObject({ source: 'template', text: (await artifact()).reportText })
    await narrative.approveText(docId, 'annualReportBody')
    await expect(documents.approve(docId)).resolves.toMatchObject({ status: 'approved' })
  })

  it('live Liner·미연결·승인된 문서·이전 형식 문서에서는 요청하지 않는다', async () => {
    client.linerMode = 'live'
    await expect(narrative.generateS5Body(docId)).rejects.toThrow('live')
    client.linerMode = 'mock'; client.token = false
    await expect(narrative.generateS5Body(docId)).rejects.toThrow('연결되어 있지 않습니다')
    expect(client.s5Calls).toHaveLength(0)
    client.token = true
    const doc = (await database.generatedDocs.get(docId))!
    const { narrativeSlots: _omit, ...legacy } = doc.content as S5Document
    await database.generatedDocs.put({ ...doc, content: legacy })
    await expect(narrative.generateS5Body(docId)).rejects.toThrow('이전 형식')
    await database.generatedDocs.put(doc)
    await documents.approve(docId)
    await expect(narrative.generateS5Body(docId)).rejects.toBeInstanceOf(NarrativeError)
  })

  it('기준 데이터가 바뀐 S5는 다시 생성하기 전까지 요청하지 않는다', async () => {
    await database.studentAllergies.add({ id: 'extra', studentId: 's2', allergenNo: 7 })
    await expect(narrative.generateS5Body(docId)).rejects.toThrow('다시 생성')
    expect(client.s5Calls).toHaveLength(0)
  })

  it('S2 키로 S5 문서를 수정할 수 없다', async () => {
    await expect(narrative.saveText(docId, 'monthlyNews', 'x')).rejects.toBeInstanceOf(NarrativeError)
  })
})
