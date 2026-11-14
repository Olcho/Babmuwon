import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BabmuwonDatabase,
  type MealEntry,
  type MealPlan,
  type Student,
  type StudentAllergy,
} from '../../data'
import { detectAllergyConflicts } from './conflictDetection'
import { ConflictDetectionService } from './conflictDetectionService'

const now = new Date().toISOString()
const students: Student[] = [
  student('student-1', '구름-01'),
  student('student-2', '별빛-02'),
]
const allergies: StudentAllergy[] = [
  { id: 'student-1:1', studentId: 'student-1', allergenNo: 1 },
  { id: 'student-2:2', studentId: 'student-2', allergenNo: 2 },
]

describe('알레르기 번호 규칙 엔진', () => {
  it('listed 메뉴는 교집합이 있는 학생에게만 정상 충돌을 만든다', () => {
    const conflicts = detectAllergyConflicts([entry('listed', 'listed', [1])], students, allergies)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ studentId: 'student-1', kind: 'allergen', allergenNos: [1] })
  })

  it('none_confirmed 메뉴와 번호상 충돌이 없는 메뉴는 결과를 만들지 않는다', () => {
    const conflicts = detectAllergyConflicts([
      entry('none', 'none_confirmed', []),
      entry('safe-by-number', 'listed', [3]),
    ], students, allergies)
    expect(conflicts).toEqual([])
  })

  it('unknown 메뉴는 알레르기 보유 학생 전원에게 확인 필요 결과를 만든다', () => {
    const conflicts = detectAllergyConflicts([entry('unknown', 'unknown', [])], students, allergies)
    expect(conflicts).toHaveLength(2)
    expect(conflicts.every((conflict) => conflict.kind === 'unknown_menu')).toBe(true)
    expect(conflicts.map((conflict) => conflict.allergenNos)).toEqual([[1], [2]])
  })
})

describe('SC-05 최신 데이터 재탐지', () => {
  let database: BabmuwonDatabase
  let service: ConflictDetectionService

  beforeEach(async () => {
    database = new BabmuwonDatabase('conflict-detection-test')
    await database.open()
    service = new ConflictDetectionService(database)
  })

  afterEach(async () => {
    database.close()
    await database.delete()
  })

  it('식단이 없거나 확정되지 않았거나 학생이 없으면 상태를 구분한다', async () => {
    expect((await service.load()).state).toBe('no_meal_plan')
    await database.mealPlans.add(plan('draft'))
    expect((await service.load()).state).toBe('not_confirmed')
    await database.mealPlans.update('plan', { status: 'confirmed' })
    expect((await service.load()).state).toBe('no_students')
  })

  it('식단 변경 시 최신 번호 기준으로 기존 결과를 없애고 새 충돌을 만든다', async () => {
    await seedConfirmedData(database)
    let overview = await service.load('2026-12')
    expect(overview.results.map((result) => result.student.id)).toEqual(['student-1'])

    await database.mealEntries.update('menu', { allergenNos: [2] })
    overview = await service.load('2026-12')
    expect(overview.results.map((result) => result.student.id)).toEqual(['student-2'])
    expect((await database.conflicts.toArray()).some((conflict) => conflict.studentId === 'student-1' && conflict.active === false)).toBe(true)
  })

  it('학생 알레르기 변경 시 최신 학생 정보로 결과를 갱신한다', async () => {
    await seedConfirmedData(database)
    expect((await service.load('2026-12')).conflictCount).toBe(1)
    await database.studentAllergies.delete('student-1:1')
    await database.studentAllergies.add({ id: 'student-1:3', studentId: 'student-1', allergenNo: 3 })
    const overview = await service.load('2026-12')
    expect(overview.results).toHaveLength(0)
    expect((await database.conflicts.toArray()).every((conflict) => conflict.active === false)).toBe(true)
  })
})

async function seedConfirmedData(database: BabmuwonDatabase) {
  await database.mealPlans.add(plan('confirmed'))
  await database.mealEntries.add(entry('menu', 'listed', [1]))
  await database.students.bulkAdd(students)
  await database.studentAllergies.bulkAdd(allergies)
}

function plan(status: MealPlan['status']): MealPlan {
  return { id: 'plan', yearMonth: '2026-12', status, sourceFile: 'sample.xlsx', unknownCount: 0, createdAt: now, updatedAt: now }
}

function entry(id: string, allergenStatus: MealEntry['allergenStatus'], allergenNos: MealEntry['allergenNos']): MealEntry {
  return {
    id, mealPlanId: 'plan', date: '2026-12-01', slot: '주찬', menuName: `가상메뉴-${id}`,
    allergenStatus, allergenNos, statusSource: 'excel', statusSetAt: now,
  }
}

function student(id: string, alias: string): Student {
  return { id, grade: 1, class: 1, number: Number(id.at(-1)), alias, needsSubstitute: true, memo: '', createdAt: now, updatedAt: now }
}
