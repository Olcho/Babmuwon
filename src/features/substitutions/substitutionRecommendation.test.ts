import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BabmuwonDatabase,
  type GeneratedDoc,
  type MealEntry,
  type MealPlan,
  type Student,
  type SubstituteMenu,
} from '../../data'
import { recommendSubstitutes } from './substitutionRecommendation'
import { SubstitutionService } from './substitutionService'

const now = new Date().toISOString()

describe('대체식 후보 추천 규칙', () => {
  const original = meal('original', '주찬', '원래메뉴', 'listed', [1])

  it('같은 슬롯에서 unknown과 학생 알레르기 번호를 제외하고 최대 5개를 추천한다', () => {
    const entries = [
      original,
      meal('safe', '주찬', '번호상후보', 'listed', [3]),
      meal('overlap', '주찬', '겹치는메뉴', 'listed', [2]),
      meal('unknown', '주찬', '미확인메뉴', 'unknown', []),
      meal('wrong-slot', '국', '다른슬롯', 'none_confirmed', []),
    ]
    const seeds = Array.from({ length: 6 }, (_, index) => seed(`seed-${index}`, `후보${index}`, '주찬'))
    const candidates = recommendSubstitutes(original, [1, 2], entries, seeds, [])
    expect(candidates).toHaveLength(5)
    expect(candidates.map((candidate) => candidate.name)).not.toEqual(expect.arrayContaining(['겹치는메뉴', '미확인메뉴', '다른슬롯']))
  })

  it('선택 기억을 우선하고 조건을 만족하는 후보가 없으면 빈 배열을 반환한다', () => {
    const seeds = [seed('a', '가후보', '주찬'), seed('b', '나후보', '주찬')]
    const remembered = [{ id: 'memory', originalMenu: '원래메뉴', allergenKey: '1', substituteName: '나후보', count: 2 }]
    expect(recommendSubstitutes(original, [1], [original], seeds, remembered)[0]?.name).toBe('나후보')
    expect(recommendSubstitutes(original, [1], [original], [seed('bad', '불가', '주찬', [1])], [])).toEqual([])
  })
})

describe('대체식 확정 저장', () => {
  let database: BabmuwonDatabase
  let service: SubstitutionService

  beforeEach(async () => {
    database = new BabmuwonDatabase('substitution-service-test')
    await database.open()
    service = new SubstitutionService(database, [])
    await seedBase(database)
  })

  afterEach(async () => {
    database.close()
    await database.delete()
  })

  it('확인 체크를 요구하고 확정·수정·취소마다 substitutionVersion을 증가시킨다', async () => {
    let overview = await service.load('2026-12')
    const item = overview.items[0]!
    await expect(service.confirm(item.conflict.id, {
      name: '번호상후보', allergenStatus: 'none_confirmed', allergenNos: [], source: 'recommended',
    }, false)).rejects.toThrow('체크')

    await service.confirm(item.conflict.id, {
      name: '번호상후보', allergenStatus: 'none_confirmed', allergenNos: [], source: 'recommended',
    }, true)
    expect((await database.dataVersions.get('current'))?.substitutionVersion).toBe(1)

    await service.confirm(item.conflict.id, {
      name: '직접대체식', allergenStatus: 'listed', allergenNos: [3], source: 'manual',
    }, true)
    expect((await database.dataVersions.get('current'))?.substitutionVersion).toBe(2)
    expect(await database.substitutions.where('conflictId').equals(item.conflict.id).first()).toMatchObject({
      status: 'confirmed', substituteName: '직접대체식', selectionSource: 'manual', checkedProcessed: true,
    })

    await service.cancelConfirmation(item.conflict.id)
    expect((await database.dataVersions.get('current'))?.substitutionVersion).toBe(3)
    expect(await database.substitutions.where('conflictId').equals(item.conflict.id).first()).toMatchObject({ status: 'pending', checkedProcessed: false })
    overview = await service.load('2026-12')
    expect(overview.items[0]?.substitution.status).toBe('pending')
  })

  it('학생 알레르기와 겹치는 직접 입력 및 unknown 충돌 확정을 막는다', async () => {
    const item = (await service.load('2026-12')).items[0]!
    await expect(service.confirm(item.conflict.id, {
      name: '잘못된대체식', allergenStatus: 'listed', allergenNos: [1], source: 'manual',
    }, true)).rejects.toThrow('겹치는 번호')
    await database.mealEntries.update('original', { allergenStatus: 'unknown', allergenNos: [] })
    const unknownItem = (await service.load('2026-12')).items[0]!
    expect(unknownItem.conflict.kind).toBe('unknown_menu')
    expect(unknownItem.candidates).toEqual([])
    await expect(service.confirm(unknownItem.conflict.id, {
      name: '직접대체식', allergenStatus: 'none_confirmed', allergenNos: [], source: 'manual',
    }, true)).rejects.toThrow('미확인 메뉴')
  })

  it('대체식 불필요 학생은 충돌만 유지하고 후보·확정을 막는다', async () => {
    await database.students.update('student', { needsSubstitute: false })
    const item = (await service.load('2026-12')).items[0]!
    expect(item.candidates).toEqual([])
    expect(item.substitution.status).toBe('excludeOnly')
    await expect(service.confirm(item.conflict.id, {
      name: '직접대체식', allergenStatus: 'none_confirmed', allergenNos: [], source: 'manual',
    }, true)).rejects.toThrow('제외만')
  })

  it('12월 대체식 변경은 12월 S3~S5만 stale 처리하고 11월 문서는 유지한다', async () => {
    const item = (await service.load('2026-12')).items[0]!
    await service.confirm(item.conflict.id, {
      name: '번호상후보', allergenStatus: 'none_confirmed', allergenNos: [], source: 'recommended',
    }, true)
    expect((await database.generatedDocs.get('doc-11'))?.status).toBe('approved')
    expect((await database.generatedDocs.get('doc-12-s2'))?.status).toBe('approved')
    expect(await database.generatedDocs.get('doc-12-s3')).toMatchObject({ status: 'stale' })
    expect(await database.generatedDocs.get('doc-12-s4-student')).toMatchObject({ status: 'stale' })
    expect(await database.generatedDocs.get('doc-12-s4-other')).toMatchObject({ status: 'approved' })
  })
})

async function seedBase(database: BabmuwonDatabase) {
  const plan: MealPlan = { id: 'plan', yearMonth: '2026-12', status: 'confirmed', confirmedAt: now, sourceFile: 'sample.xlsx', unknownCount: 0, createdAt: now, updatedAt: now }
  const student: Student = { id: 'student', grade: 1, class: 1, number: 1, alias: '구름-01', needsSubstitute: true, memo: '', createdAt: now, updatedAt: now }
  const documents: GeneratedDoc[] = [
    doc('doc-11', 'S3', '2026-11'), doc('doc-12-s2', 'S2', '2026-12'), doc('doc-12-s3', 'S3', '2026-12'),
    { ...doc('doc-12-s4-student', 'S4', '2026-12'), subjectId: 'student' },
    { ...doc('doc-12-s4-other', 'S4', '2026-12'), subjectId: 'other-student' },
  ]
  await database.mealPlans.add(plan)
  await database.mealEntries.bulkAdd([
    meal('original', '주찬', '원래메뉴', 'listed', [1]),
    meal('candidate', '주찬', '번호상후보', 'none_confirmed', []),
  ])
  await database.students.add(student)
  await database.studentAllergies.add({ id: 'student:1', studentId: 'student', allergenNo: 1 })
  await database.generatedDocs.bulkAdd(documents)
}

function meal(id: string, slot: string, menuName: string, allergenStatus: MealEntry['allergenStatus'], allergenNos: MealEntry['allergenNos']): MealEntry {
  return { id, mealPlanId: 'plan', date: '2026-12-01', slot, menuName, allergenStatus, allergenNos, statusSource: 'excel', statusSetAt: now }
}

function seed(id: string, name: string, slot: string, allergenNos: SubstituteMenu['allergenNos'] = []): SubstituteMenu {
  return { id, name, slot, allergenStatus: allergenNos.length ? 'listed' : 'none_confirmed', allergenNos }
}

function doc(id: string, docType: GeneratedDoc['docType'], yearMonth: GeneratedDoc['yearMonth']): GeneratedDoc {
  return {
    id, docType, yearMonth, docVersion: 1, basedOn: { planVersion: 0, studentVersion: 0, substitutionVersion: 0 },
    status: 'approved', approvedAt: now, correctionNeeded: false, createdAt: now, updatedAt: now,
  }
}
