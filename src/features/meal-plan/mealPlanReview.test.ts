import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BabmuwonDatabase,
  MealRepository,
  type Conflict,
  type GeneratedDoc,
  type MealEntry,
  type MealPlan,
  type Student,
  type Substitution,
} from '../../data'

describe('식단 확정 R-31 재검토 연동', () => {
  let database: BabmuwonDatabase

  beforeEach(async () => {
    database = new BabmuwonDatabase('meal-review-test')
    await database.open()
  })

  afterEach(async () => {
    database.close()
    await database.delete()
  })

  it('변경된 12월 충돌만 재검토하고 11월 대체식과 문서는 유지한다', async () => {
    const now = new Date().toISOString()
    const plans: MealPlan[] = [
      { id: 'plan-11', yearMonth: '2026-11', status: 'confirmed', confirmedAt: now, sourceFile: '11.xlsx', unknownCount: 0, createdAt: now, updatedAt: now },
      { id: 'plan-12', yearMonth: '2026-12', status: 'draft', sourceFile: '12.xlsx', unknownCount: 0, createdAt: now, updatedAt: now },
    ]
    const entries: MealEntry[] = [
      entry('entry-unchanged', 'plan-12', '2026-12-01', '주찬', '그대로메뉴', [5], now),
      entry('entry-changed', 'plan-12', '2026-12-01', '국', '번호변경메뉴', [6], now),
      entry('entry-new', 'plan-12', '2026-12-01', '부찬', '새충돌메뉴', [6], now),
    ]
    const student: Student = {
      id: 'student', grade: 1, class: 1, number: 1, alias: '구름-27', needsSubstitute: true,
      memo: '', createdAt: now, updatedAt: now,
    }
    const conflicts: Conflict[] = [
      conflict('conflict-november', '2026-11-01', '주찬', '11월메뉴', [5]),
      conflict('conflict-unchanged', '2026-12-01', '주찬', '그대로메뉴', [5]),
      conflict('conflict-changed', '2026-12-01', '국', '번호변경메뉴', [5]),
      conflict('conflict-removed', '2026-12-01', '후식', '사라진메뉴', [5]),
    ]
    const substitutions: Substitution[] = conflicts.map((item) => substitution(`sub-${item.id}`, item.id, now))
    const documents: GeneratedDoc[] = [
      document('doc-11', '2026-11', 'approved', now),
      document('doc-12', '2026-12', 'sent', now),
    ]

    await database.mealPlans.bulkAdd(plans)
    await database.mealEntries.bulkAdd(entries)
    await database.students.add(student)
    await database.studentAllergies.bulkAdd([
      { id: 'student:5', studentId: student.id, allergenNo: 5 },
      { id: 'student:6', studentId: student.id, allergenNo: 6 },
    ])
    await database.conflicts.bulkAdd(conflicts)
    await database.substitutions.bulkAdd(substitutions)
    await database.generatedDocs.bulkAdd(documents)

    await new MealRepository(database).confirm('plan-12', now)

    expect(await database.substitutions.get('sub-conflict-november')).toMatchObject({ status: 'confirmed', checkedProcessed: true })
    expect(await database.generatedDocs.get('doc-11')).toMatchObject({ status: 'approved', correctionNeeded: false })
    expect(await database.substitutions.get('sub-conflict-unchanged')).toMatchObject({ status: 'confirmed', checkedProcessed: true })
    expect(await database.substitutions.get('sub-conflict-changed')).toMatchObject({ status: 'needs_review', checkedProcessed: false })
    expect(await database.substitutions.get('sub-conflict-removed')).toMatchObject({ status: 'obsolete' })
    expect(await database.conflicts.get('conflict-removed')).toMatchObject({ active: false })
    expect(await database.generatedDocs.get('doc-12')).toMatchObject({ status: 'stale', correctionNeeded: true })

    const newConflict = await database.conflicts.where('mealEntryId').equals('entry-new').first()
    expect(newConflict).toMatchObject({ active: true, menuName: '새충돌메뉴' })
    expect(await database.substitutions.where('conflictId').equals(newConflict!.id).first()).toMatchObject({ status: 'pending' })
  })
})

function entry(
  id: string,
  mealPlanId: string,
  date: string,
  slot: string,
  menuName: string,
  allergenNos: (5 | 6)[],
  now: string,
): MealEntry {
  return { id, mealPlanId, date, slot, menuName, allergenStatus: 'listed', allergenNos, statusSource: 'excel', statusSetAt: now }
}

function conflict(id: string, date: string, slot: string, menuName: string, allergenNos: (5 | 6)[]): Conflict {
  return { id, date, studentId: 'student', mealEntryId: `old-${id}`, slot, menuName, kind: 'allergen', allergenNos, active: true }
}

function substitution(id: string, conflictId: string, now: string): Substitution {
  return {
    id, conflictId, substituteName: '가상대체식', checkedProcessed: true, checkedAt: now,
    status: 'confirmed', basedOn: { planVersion: 1, studentVersion: 1 }, createdAt: now, updatedAt: now,
  }
}

function document(id: string, yearMonth: '2026-11' | '2026-12', status: 'approved' | 'sent', now: string): GeneratedDoc {
  return {
    id, docType: 'S2', yearMonth, docVersion: 1,
    basedOn: { planVersion: 1, studentVersion: 1, substitutionVersion: 1 },
    status, approvedAt: now, correctionNeeded: false, createdAt: now, updatedAt: now,
  }
}
