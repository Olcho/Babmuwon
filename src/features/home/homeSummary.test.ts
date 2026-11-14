import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BabmuwonDatabase } from '../../data'
import { loadHomeSummary } from './homeSummary'

const at = '2026-11-15T00:00:00.000Z'

describe('홈 상태 요약', () => {
  let database: BabmuwonDatabase
  beforeEach(async () => { database = new BabmuwonDatabase(`home-${crypto.randomUUID()}`); await database.open() })
  afterEach(async () => { database.close(); await database.delete() })

  it('식단이 없으면 미업로드 상태를 돌려준다', async () => {
    expect(await loadHomeSummary(database)).toMatchObject({ month: undefined, documents: { generated: 0 }, substitutions: { open: 0 } })
  })

  it('최신 월 기준으로 미확정 대체식·확인 필요·문서 상태를 센다', async () => {
    await database.mealPlans.bulkAdd([
      { id: 'p11', yearMonth: '2026-11', status: 'confirmed', sourceFile: 'a.xlsx', unknownCount: 0, createdAt: at, updatedAt: at },
      { id: 'p12', yearMonth: '2026-12', status: 'confirmed', sourceFile: 'b.xlsx', unknownCount: 1, createdAt: at, updatedAt: at },
    ])
    const conflict = (id: string, date: string, kind: 'allergen' | 'unknown_menu') => ({ id, date, studentId: 's', mealEntryId: 'e', menuName: 'm', kind, allergenNos: [], active: true })
    await database.conflicts.bulkAdd([conflict('c1', '2026-12-01', 'allergen'), conflict('c2', '2026-12-02', 'allergen'), conflict('c3', '2026-12-03', 'unknown_menu'), conflict('c4', '2026-11-03', 'allergen')])
    const sub = (id: string, status: 'pending' | 'confirmed' | 'needs_review') => ({ id: `s-${id}`, conflictId: id, checkedProcessed: false, status, basedOn: { planVersion: 1, studentVersion: 1 }, createdAt: at, updatedAt: at })
    await database.substitutions.bulkAdd([sub('c1', 'confirmed'), sub('c2', 'needs_review'), sub('c4', 'pending')])
    const doc = (id: string, docType: 'S1' | 'S2', status: 'approved' | 'stale', docVersion = 1) => ({ id, docType, yearMonth: '2026-12' as const, docVersion, basedOn: { planVersion: 1, studentVersion: 1, substitutionVersion: 1 }, status, correctionNeeded: false, createdAt: at, updatedAt: at })
    await database.generatedDocs.bulkAdd([doc('d1', 'S1', 'stale'), doc('d2', 'S2', 'approved'), doc('d3', 'S1', 'approved', 2)])
    const summary = await loadHomeSummary(database)
    expect(summary.month).toBe('2026-12')
    expect(summary.substitutions).toEqual({ total: 3, open: 1, needsReview: 1, unknownMenu: 1 })
    expect(summary.documents).toEqual({ generated: 2, total: 5, stale: 0, s2Approved: true }) // S1은 최신 버전(v2, 승인)만 센다
  })
})
