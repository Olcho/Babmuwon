import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BabmuwonDatabase, MealRepository, type MealPlan, type YearMonth } from '../../data'
import { DocumentService } from '../documents/documentService'
import type { S2Document } from '../documents/documentModels'
import { MockSendService } from '../sending/mockSendService'
import { SubstitutionService } from '../substitutions/substitutionService'

const at = '2026-11-15T00:00:00.000Z'

describe('월 식단 삭제', () => {
  let database: BabmuwonDatabase
  let meals: MealRepository
  let documents: DocumentService

  beforeEach(async () => {
    database = new BabmuwonDatabase(`meal-delete-${crypto.randomUUID()}`)
    await database.open()
    meals = new MealRepository(database)
    documents = new DocumentService(database)
    await database.students.add({ id: 's1', grade: 1, class: 1, number: 1, alias: '구름-01', needsSubstitute: true, memo: '', createdAt: at, updatedAt: at })
    await database.studentAllergies.add({ id: 's1:5', studentId: 's1', allergenNo: 5 })
    await seedPlan('2026-11'); await seedPlan('2026-12')
    await meals.confirm('plan-2026-11', at); await meals.confirm('plan-2026-12', at)
  })
  afterEach(async () => { database.close(); await database.delete() })

  async function seedPlan(month: YearMonth, status: MealPlan['status'] = 'draft') {
    const id = `plan-${month}`
    await database.mealPlans.put({ id, yearMonth: month, status, sourceFile: `${month}.xlsx`, unknownCount: 0, createdAt: at, updatedAt: at })
    await database.mealEntries.bulkPut([
      { id: `${id}:1`, mealPlanId: id, date: `${month}-02`, slot: '주찬', menuName: '닭갈비', allergenStatus: 'listed', allergenNos: [5], statusSource: 'excel', statusSetAt: at },
      { id: `${id}:2`, mealPlanId: id, date: `${month}-02`, slot: '부찬', menuName: '감자채볶음', allergenStatus: 'none_confirmed', allergenNos: [], statusSource: 'excel', statusSetAt: at },
    ])
  }

  async function confirmSubstitute(month: YearMonth) {
    const service = new SubstitutionService(database)
    const item = (await service.load(month)).items[0]!
    await service.confirm(item.conflict.id, { name: '감자채볶음', allergenStatus: 'none_confirmed', allergenNos: [], source: 'manual' }, true)
  }

  async function approvedS2(month: YearMonth) {
    const generated = await documents.generateS2(month)
    const content = generated.content as S2Document
    await database.generatedDocs.put({ ...generated, s2DeliveryState: 'synced', content: { ...content, narrativeSlots: content.narrativeSlots.map((slot) => ({ ...slot, state: 'approved' as const, text: '문구' })) } })
    return documents.approve(generated.id)
  }

  it('해당 월 식단만 삭제하고 충돌·대체식은 이력을 남긴 채 obsolete, 관련 문서는 stale로 바꾼다', async () => {
    await confirmSubstitute('2026-11'); await confirmSubstitute('2026-12')
    const novS1 = await documents.approve((await documents.generateS1('2026-11')).id)
    const decS1 = await documents.approve((await documents.generateS1('2026-12')).id)
    const decS2 = await approvedS2('2026-12')
    const s5 = await documents.approve((await documents.generateS5('2026')).id)
    const before = (await database.dataVersions.get('current'))!

    const result = await meals.deletePlan('plan-2026-12', at)
    expect(result).toEqual({ yearMonth: '2026-12', obsoleteSubstitutions: 1, staleDocuments: 3 })

    // 식단: 12월만 삭제
    expect(await database.mealPlans.get('plan-2026-12')).toBeUndefined()
    expect(await database.mealEntries.where('mealPlanId').equals('plan-2026-12').count()).toBe(0)
    expect(await database.mealPlans.get('plan-2026-11')).toBeTruthy()
    expect(await database.mealEntries.where('mealPlanId').equals('plan-2026-11').count()).toBe(2)
    // 학생 정보 유지
    expect(await database.students.count()).toBe(1)
    expect(await database.studentAllergies.count()).toBe(1)
    // 충돌·대체식: 12월은 비활성·obsolete(이력 보존), 11월은 그대로
    const conflicts = await database.conflicts.toArray()
    expect(conflicts.filter((item) => item.date.startsWith('2026-12')).every((item) => item.active === false)).toBe(true)
    expect(conflicts.filter((item) => item.date.startsWith('2026-11')).every((item) => item.active !== false)).toBe(true)
    const subs = await database.substitutions.toArray()
    const byMonth = (month: string) => subs.filter((sub) => conflicts.find((item) => item.id === sub.conflictId)?.date.startsWith(month))
    expect(byMonth('2026-12').map((sub) => sub.status)).toEqual(['obsolete'])
    expect(byMonth('2026-12')[0]?.substituteName).toBe('감자채볶음')
    expect(byMonth('2026-11').map((sub) => sub.status)).toEqual(['confirmed'])
    // 버전
    const after = (await database.dataVersions.get('current'))!
    expect(after.planVersion).toBe(before.planVersion + 1)
    expect(after.substitutionVersion).toBe(before.substitutionVersion + 1)
    expect(after.studentVersion).toBe(before.studentVersion)
    // 문서: 12월·2026 S5만 stale
    expect(await database.generatedDocs.get(decS1.id)).toMatchObject({ status: 'stale', staleReason: '2026-12 식단이 삭제되어 재검토가 필요합니다.' })
    expect(await database.generatedDocs.get(decS2.id)).toMatchObject({ status: 'stale', s2DeliveryState: 'sync_required' })
    expect((await database.generatedDocs.get(s5.id))?.status).toBe('stale')
    expect((await database.generatedDocs.get(novS1.id))?.status).toBe('approved')
    // 삭제된 달의 S2는 Mock 발송도 막힌다
    expect((await new MockSendService(database).checkEligibility(decS2.id)).eligible).toBe(false)
  })

  it('작성 중(미확정) 식단 삭제는 식단 버전을 올리지 않는다', async () => {
    await seedPlan('2027-01')
    const before = (await database.dataVersions.get('current'))!
    await meals.deletePlan('plan-2027-01', at)
    expect((await database.dataVersions.get('current'))!.planVersion).toBe(before.planVersion)
    expect(await database.mealPlans.count()).toBe(2)
  })

  it('삭제 후 같은 달을 다시 올려 확정하면 충돌을 새로 탐지하고 이전 이력은 남는다', async () => {
    await confirmSubstitute('2026-12')
    await meals.deletePlan('plan-2026-12', at)
    await seedPlan('2026-12')
    await meals.confirm('plan-2026-12', at)
    const december = (await database.conflicts.toArray()).filter((item) => item.date.startsWith('2026-12'))
    expect(december.filter((item) => item.active !== false)).toHaveLength(1)
    expect(december.filter((item) => item.active === false)).toHaveLength(1)
    const active = december.find((item) => item.active !== false)!
    expect((await database.substitutions.where('conflictId').equals(active.id).first())?.status).toBe('pending')
  })

  it('없는 식단은 삭제할 수 없다', async () => {
    await expect(meals.deletePlan('nope', at)).rejects.toThrow('찾을 수 없습니다')
  })
})
