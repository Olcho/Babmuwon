import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BabmuwonDatabase } from './database'
import { MealRepository, SchoolRepository, StudentRepository, SubstitutionRepository, VersionRepository } from './repositories'
import type { MealEntry, MealPlan, Student, Substitution } from './types'

const name = 'babmuwon-test'
let database: BabmuwonDatabase

beforeEach(async () => {
  database = new BabmuwonDatabase(name)
  await database.open()
})

afterEach(async () => {
  database.close()
  await database.delete()
})

describe('IndexedDB 저장 계층', () => {
  it('학교 정보를 저장, 조회, 수정, 삭제한다', async () => {
    const schools = new SchoolRepository(database)
    await schools.save({ name: '가상중학교', principal: '교장', manager: '영양사', phone: '02-000-0000', headcount: 300 })
    expect((await schools.get())?.headcount).toBe(300)
    await schools.save({ name: '가상중학교', principal: '교장', manager: '영양사', phone: '02-000-0000', headcount: 301 })
    expect((await schools.get())?.headcount).toBe(301)
    await schools.delete()
    expect(await schools.get()).toBeUndefined()
  })

  it('DB 연결을 닫고 다시 열어도 로컬 데이터가 유지된다', async () => {
    const schools = new SchoolRepository(database)
    await schools.save({ name: '새로고침가상학교', principal: '', manager: '', phone: '', headcount: 10 })
    database.close()
    database = new BabmuwonDatabase(name)
    await database.open()
    expect((await new SchoolRepository(database).get())?.name).toBe('새로고침가상학교')
  })

  it('식단 확정과 메뉴 수정 시 planVersion을 증가시킨다', async () => {
    const meals = new MealRepository(database)
    const now = new Date().toISOString()
    const plan: MealPlan = { id: 'plan-1', yearMonth: '2026-12', status: 'draft', sourceFile: 'sample.xlsx', unknownCount: 0, createdAt: now, updatedAt: now }
    const entry: MealEntry = { id: 'entry-1', mealPlanId: plan.id, date: '2026-12-01', slot: '주찬', menuName: '가상메뉴', allergenStatus: 'none_confirmed', allergenNos: [], statusSource: 'manual', statusSetAt: now }
    await meals.saveDraft(plan, [entry])
    await meals.confirm(plan.id, now)
    await meals.updateEntry({ ...entry, menuName: '수정된가상메뉴' })
    expect((await new VersionRepository(database).get()).planVersion).toBe(2)
  })

  it('학생과 알레르기를 원자적으로 저장하고 studentVersion을 증가시킨다', async () => {
    const students = new StudentRepository(database)
    const now = new Date().toISOString()
    const student: Student = { id: 'student-1', grade: 1, class: 2, number: 3, alias: '구름-27', needsSubstitute: true, memo: '', createdAt: now, updatedAt: now }
    await students.save(student, [1, 5])
    expect((await students.getAllergies(student.id)).map((item) => item.allergenNo).sort()).toEqual([1, 5])
    expect((await new VersionRepository(database).get()).studentVersion).toBe(1)
  })

  it('확인 체크 없는 대체식 확정을 막고 확정 시 substitutionVersion을 증가시킨다', async () => {
    const substitutions = new SubstitutionRepository(database)
    const now = new Date().toISOString()
    const value: Substitution = { id: 'sub-1', conflictId: 'conflict-1', substituteName: '가상대체식', checkedProcessed: false, status: 'confirmed', basedOn: { planVersion: 1, studentVersion: 1 }, createdAt: now, updatedAt: now }
    await expect(substitutions.save(value)).rejects.toThrow('확인 체크')
    await substitutions.save({ ...value, checkedProcessed: true, checkedAt: now })
    expect((await new VersionRepository(database).get()).substitutionVersion).toBe(1)
  })
})
