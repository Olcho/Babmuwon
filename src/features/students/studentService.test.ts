import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BabmuwonDatabase, type GeneratedDoc } from '../../data'
import { StudentService, StudentValidationError, type StudentInput } from './studentService'

describe('SC-03 학생 알레르기 서비스', () => {
  let database: BabmuwonDatabase
  let service: StudentService
  let suffix = 7

  beforeEach(async () => {
    database = new BabmuwonDatabase('student-service-test')
    await database.open()
    suffix = 7
    service = new StudentService(database, ['우유', '별빛'], (max) => max === 100 ? suffix++ : 0)
  })

  afterEach(async () => {
    database.close()
    await database.delete()
  })

  it('금지 단어를 제외해 중복 없는 가명을 만들고 삭제 후에도 재사용하지 않는다', async () => {
    const first = await service.create(input({ grade: 1, class: 1, number: 1 }))
    expect(first.student.alias).toBe('별빛-07')
    await service.delete(first.student.id)
    const second = await service.create(input({ grade: 1, class: 1, number: 2 }))
    expect(second.student.alias).toBe('별빛-08')
    expect((await database.aliasHistories.toArray()).map((item) => item.alias).sort()).toEqual(['별빛-07', '별빛-08'])
  })

  it('학교명·등록 실명·메뉴명과 겹치는 가명 단어를 제외한다', async () => {
    const now = new Date().toISOString()
    await database.schools.put({ id: 'school', name: '구름학교', principal: '', manager: '', phone: '', headcount: 0 })
    await database.mealEntries.put({
      id: 'menu', mealPlanId: 'plan', date: '2026-12-01', slot: '국', menuName: '별빛국',
      allergenStatus: 'none_confirmed', allergenNos: [], statusSource: 'manual', statusSetAt: now,
    })
    await database.students.put({
      id: 'existing', grade: 6, class: 1, number: 1, alias: '기존-00', realName: '바람',
      needsSubstitute: true, memo: '', createdAt: now, updatedAt: now,
    })
    const filteredService = new StudentService(database, ['구름', '별빛', '바람', '노을'], (max) => max === 100 ? 7 : 0)
    const created = await filteredService.create(input({ grade: 6, class: 1, number: 2 }))
    expect(created.student.alias).toBe('노을-07')
  })

  it('동일 학년·반·번호와 필수 입력 누락을 차단한다', async () => {
    await service.create(input({ grade: 2, class: 3, number: 4 }))
    await expect(service.create(input({ grade: 2, class: 3, number: 4 }))).rejects.toThrow('이미 등록')
    await expect(service.create(input({ grade: 2, class: 3, number: 5, allergenNos: [] }))).rejects.toThrow('1개 이상')
    await expect(service.create(input({ grade: 0, class: 3, number: 5 }))).rejects.toBeInstanceOf(StudentValidationError)
  })

  it('저장·수정·가명 재생성·삭제마다 studentVersion을 증가시킨다', async () => {
    const created = await service.create(input({ grade: 3, class: 1, number: 1 }))
    await service.update(created.student.id, input({ grade: 3, class: 1, number: 2, allergenNos: [1, 5] }))
    await service.regenerateAlias(created.student.id)
    await service.delete(created.student.id)
    expect((await database.dataVersions.get('current'))?.studentVersion).toBe(4)
  })

  it('학생 변경 시 S3~S5만 stale 처리하고 S1·S2는 유지한다', async () => {
    const now = new Date().toISOString()
    const documents: GeneratedDoc[] = ['S1', 'S2', 'S3', 'S4', 'S5'].map((docType) => ({
      id: `doc-${docType}`, docType: docType as GeneratedDoc['docType'], yearMonth: '2026-12', docVersion: 1,
      basedOn: { planVersion: 1, studentVersion: 0, substitutionVersion: 0 }, status: 'approved',
      approvedAt: now, correctionNeeded: false, createdAt: now, updatedAt: now,
    }))
    await database.generatedDocs.bulkAdd(documents)
    await service.create(input({ grade: 4, class: 1, number: 1 }))
    expect((await database.generatedDocs.get('doc-S1'))?.status).toBe('approved')
    expect((await database.generatedDocs.get('doc-S2'))?.status).toBe('approved')
    for (const type of ['S3', 'S4', 'S5']) expect(await database.generatedDocs.get(`doc-${type}`)).toMatchObject({ status: 'stale' })
  })

  it('DB를 다시 열어도 학생과 알레르기 정보가 유지된다', async () => {
    await service.create(input({ grade: 5, class: 2, number: 9, allergenNos: [2, 6] }))
    database.close()
    database = new BabmuwonDatabase('student-service-test')
    await database.open()
    service = new StudentService(database)
    const records = await service.getAll()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ student: { grade: 5, class: 2, number: 9 }, allergenNos: [2, 6] })
  })
})

function input(overrides: Partial<StudentInput> = {}): StudentInput {
  return {
    grade: 1, class: 1, number: 1, realName: '', needsSubstitute: true, memo: '', allergenNos: [1],
    ...overrides,
  }
}
