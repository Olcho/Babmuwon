import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BabmuwonDatabase, MealRepository, type Conflict, type MealEntry, type MealPlan, type Student, type Substitution } from '../../data'
import { buildS1Document, buildS3Document, buildS5Document } from './documentBuilders'
import { createDocumentWorkbook } from './documentExporters'
import { DocumentService } from './documentService'

const at = '2026-11-15T00:00:00.000Z'
const version = { id: 'current' as const, planVersion: 2, studentVersion: 3, substitutionVersion: 4, updatedAt: at }

describe('S1/S3/S5 문서 구성', () => {
  it('월간·주간 식단과 allergen 상태를 구분하고 XLSX 시트를 만든다', () => {
    const doc = buildS1Document('2026-12', [entry('a', '2026-12-01', '주찬', '닭갈비', 'listed', [5, 6]), entry('b', '2026-12-01', '국', '미확인국', 'unknown', [])], version, at)
    expect(doc.rows[0]?.menus.map((item) => item.label)).toEqual(['닭갈비 5.6', '미확인국 (미확인)'])
    expect(doc.weeks).toHaveLength(1)
    expect(createDocumentWorkbook(doc).SheetNames).toEqual(expect.arrayContaining(['월간 식단표', '1주차', '알레르기 범례']))
  })

  it('S3는 확정 대체식만 작업표로 만들고 unknown 또는 미확정 항목을 차단한다', () => {
    const student = makeStudent()
    const conflict = makeConflict('c', 'allergen')
    const substitution = makeSubstitution('c', 'confirmed')
    const doc = buildS3Document('2026-12', [conflict], [substitution], [student], version, at)
    expect(doc.rows[0]).toMatchObject({ studentDisplay: '1학년 2반 3번 (구름-01)', substituteMenu: '가상 대체식' })
    expect(createDocumentWorkbook(doc).SheetNames).toEqual(['내부 작업표', '일자별 합계'])
    expect(() => buildS3Document('2026-12', [{ ...conflict, kind: 'unknown_menu' }], [substitution], [student], version, at)).toThrow('생성할 수 없습니다')
  })

  it('S5는 로컬 학생·알레르기·연간 처리 현황을 중복 없이 집계한다', () => {
    const student = makeStudent()
    const doc = buildS5Document('2026', [student], [
      { id: 'a1', studentId: student.id, allergenNo: 1 }, { id: 'a2', studentId: student.id, allergenNo: 5 },
    ], [makeConflict('c', 'allergen')], [makeSubstitution('c', 'confirmed')], version, at)
    expect(doc).toMatchObject({ totalStudents: 1, providedCount: 1, excludedCount: 0 })
    expect(doc.byAllergen.find((item) => item.allergenNo === 1)?.students).toBe(1)
    expect(createDocumentWorkbook(doc).SheetNames).toEqual(['운영 보고', '알레르기별 통계', '학년별 통계'])
  })
})

describe('문서 저장·승인·월 범위 stale', () => {
  let database: BabmuwonDatabase
  let service: DocumentService
  beforeEach(async () => { database = new BabmuwonDatabase(`documents-${crypto.randomUUID()}`); await database.open(); service = new DocumentService(database) })
  afterEach(async () => { database.close(); await database.delete() })

  it('생성 시 버전·시각·내용을 IndexedDB에 저장하고 최신 문서만 승인한다', async () => {
    await seedPlan(database, '2026-12', 'plan-12')
    const generated = await service.generateS1('2026-12')
    expect(generated).toMatchObject({ docType: 'S1', docVersion: 1, status: 'draft', basedOn: { planVersion: 0 } })
    expect(generated.generatedAt).toBeTruthy()
    expect((await service.approve(generated.id)).status).toBe('approved')
    expect((await database.generatedDocs.get(generated.id))?.content).toBeTruthy()
  })

  it('12월 재확정은 12월과 해당 연도 S5만 stale 처리하고 11월 승인본은 유지한다', async () => {
    await seedPlan(database, '2026-11', 'plan-11')
    await seedPlan(database, '2026-12', 'plan-12')
    const november = await service.approve((await service.generateS1('2026-11')).id)
    const december = await service.approve((await service.generateS1('2026-12')).id)
    const annual = await service.approve((await service.generateS5('2026')).id)
    await new MealRepository(database).confirm('plan-12', at)
    expect((await database.generatedDocs.get(november.id))?.status).toBe('approved')
    expect((await database.generatedDocs.get(december.id))?.status).toBe('stale')
    expect((await database.generatedDocs.get(annual.id))?.status).toBe('stale')
  })
})

async function seedPlan(database: BabmuwonDatabase, yearMonth: '2026-11' | '2026-12', id: string) {
  const plan: MealPlan = { id, yearMonth, status: 'confirmed', confirmedAt: at, sourceFile: 'virtual.xlsx', unknownCount: 0, createdAt: at, updatedAt: at }
  await database.mealPlans.add(plan)
  await database.mealEntries.add(entry(`${id}-entry`, `${yearMonth}-01`, '주찬', '가상 메뉴', 'none_confirmed', [], id))
}
function entry(id: string, date: string, slot: string, menuName: string, allergenStatus: MealEntry['allergenStatus'], allergenNos: MealEntry['allergenNos'], mealPlanId = 'plan'): MealEntry { return { id, mealPlanId, date, slot, menuName, allergenStatus, allergenNos, statusSource: 'manual', statusSetAt: at } }
function makeStudent(): Student { return { id: 'student', grade: 1, class: 2, number: 3, alias: '구름-01', needsSubstitute: true, memo: '', createdAt: at, updatedAt: at } }
function makeConflict(id: string, kind: Conflict['kind']): Conflict { return { id, date: '2026-12-01', studentId: 'student', mealEntryId: 'entry', slot: '주찬', menuName: '원 메뉴', kind, allergenNos: kind === 'allergen' ? [1] : [], active: true } }
function makeSubstitution(conflictId: string, status: Substitution['status']): Substitution { return { id: `sub-${conflictId}`, conflictId, substituteName: '가상 대체식', checkedProcessed: true, status, basedOn: { planVersion: 2, studentVersion: 3 }, createdAt: at, updatedAt: at } }
