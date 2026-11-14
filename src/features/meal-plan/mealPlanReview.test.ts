import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BabmuwonDatabase, MealRepository, type GeneratedDoc, type MealPlan, type Substitution } from '../../data'

describe('식단 확정 재검토 연동', () => {
  let database: BabmuwonDatabase

  beforeEach(async () => {
    database = new BabmuwonDatabase('meal-review-test')
    await database.open()
  })

  afterEach(async () => {
    database.close()
    await database.delete()
  })

  it('확정 시 기존 확정 대체식과 승인·발송 문서를 재검토 상태로 바꾼다', async () => {
    const now = new Date().toISOString()
    const plan: MealPlan = { id: 'plan', yearMonth: '2026-12', status: 'draft', sourceFile: 'sample.xlsx', unknownCount: 0, createdAt: now, updatedAt: now }
    const substitution: Substitution = { id: 'sub', conflictId: 'conflict', substituteName: '가상대체식', checkedProcessed: true, checkedAt: now, status: 'confirmed', basedOn: { planVersion: 0, studentVersion: 0 }, createdAt: now, updatedAt: now }
    const document: GeneratedDoc = { id: 'doc', docType: 'S2', yearMonth: '2026-12', docVersion: 1, basedOn: { planVersion: 0, studentVersion: 0, substitutionVersion: 0 }, status: 'sent', approvedAt: now, correctionNeeded: false, createdAt: now, updatedAt: now }
    await database.mealPlans.add(plan)
    await database.substitutions.add(substitution)
    await database.generatedDocs.add(document)

    await new MealRepository(database).confirm(plan.id, now)

    expect(await database.substitutions.get('sub')).toMatchObject({ status: 'needs_review', checkedProcessed: false })
    expect(await database.generatedDocs.get('doc')).toMatchObject({ status: 'stale', correctionNeeded: true })
    expect((await database.dataVersions.get('current'))?.planVersion).toBe(1)
  })
})
