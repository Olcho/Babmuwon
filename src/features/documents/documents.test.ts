import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BabmuwonDatabase, MealRepository, type Conflict, type MealEntry, type MealPlan, type Student, type Substitution } from '../../data'
import JSZip from 'jszip'
import { buildS1Document, buildS2Document, buildS3Document, buildS4Documents, buildS5Document } from './documentBuilders'
import { createDocumentWorkbook } from './documentExporters'
import { createS4Zip } from './documentPdf'
import { DocumentService, isS2SendEligible } from './documentService'

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

describe('S2/S4 문서 구성과 출력', () => {
  it('S2는 식단·학교·알레르기 정보를 포함하고 AI 문구는 미생성 상태로 둔다', () => {
    const document = buildS2Document('2026-12', [entry('a', '2026-12-01', '중식', '가상 메뉴', 'listed', [1])], {
      id: 'school', name: '가상학교', principal: '가상교장', manager: '가상담당', phone: '02-000-0000', headcount: 100,
      motto: '건강하게 배우자', address: '가상시 가상로', homepage: 'https://example.invalid',
    }, version, at)
    expect(document).toMatchObject({ type: 'S2', school: { name: '가상학교' }, sendState: 'awaiting_local_s2_state' })
    expect(document.mealTable.rows[0]?.menus[0]?.label).toBe('가상 메뉴 1')
    expect(document.narrativeSlots.every((slot) => slot.state === 'not_generated' && slot.text === '')).toBe(true)
  })

  it('S4는 학생별 확정 항목만 만들고 미확정·unknown 학생은 제외한다', () => {
    const student = makeStudent()
    const ready = makeConflict('ready', 'allergen')
    const blocked = { ...makeConflict('blocked', 'unknown_menu'), studentId: 'blocked-student' }
    const blockedStudent = { ...student, id: 'blocked-student', number: 4, alias: '별빛-02' }
    const result = buildS4Documents('2026-12', [ready, blocked], [makeSubstitution('ready', 'confirmed'), makeSubstitution('blocked', 'pending')], [student, blockedStudent], [{ id: 'allergy', studentId: student.id, allergenNo: 1 }], version, at)
    expect(result.documents).toHaveLength(1)
    expect(result.documents[0]).toMatchObject({ recipient: '1학년 2반 3번 학부모님', rows: [{ substituteMenu: '가상 대체식' }] })
    expect(result.blockedStudentIds).toEqual(['blocked-student'])
  })

  it('학생별 PDF 결과를 실제 ZIP 엔트리로 묶는다', async () => {
    const document = buildS4Documents('2026-12', [makeConflict('c', 'allergen')], [makeSubstitution('c', 'confirmed')], [makeStudent()], [{ id: 'allergy', studentId: 'student', allergenNo: 1 }], version, at).documents[0]!
    const zipBlob = await createS4Zip([document], async () => new Blob(['%PDF-1.4\nvirtual'], { type: 'application/pdf' }))
    const archive = await JSZip.loadAsync(await zipBlob.arrayBuffer())
    const filename = Object.keys(archive.files)[0]!
    expect(filename).toMatch(/\.pdf$/)
    expect(await archive.file(filename)?.async('string')).toContain('%PDF-1.4')
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

  it('S2는 AI 문구 미생성 상태에서 승인·발송 가능 상태가 되지 않는다', async () => {
    await seedPlan(database, '2026-12', 'plan-12')
    const document = await service.generateS2('2026-12')
    expect(document.s2DeliveryState).toBe('not_connected')
    expect(isS2SendEligible(document)).toBe(false)
    await expect(service.approve(document.id)).rejects.toThrow('생성·검토되지 않아')
    expect((await database.generatedDocs.get(document.id))?.status).toBe('draft')
  })

  it('S4를 학생별 저장하고 식단 변경 시 해당 월만 stale 처리한다', async () => {
    await seedPlan(database, '2026-11', 'plan-11')
    await seedPlan(database, '2026-12', 'plan-12')
    await seedS4Input(database, '2026-11', 'nov')
    await seedS4Input(database, '2026-12', 'dec')
    const november = (await service.generateS4('2026-11')).documents[0]!
    const december = (await service.generateS4('2026-12')).documents[0]!
    await service.approve(november.id); await service.approve(december.id)
    await new MealRepository(database).confirm('plan-12', at)
    expect((await database.generatedDocs.get(november.id))?.status).toBe('approved')
    expect((await database.generatedDocs.get(december.id))?.status).toBe('stale')
  })
})

async function seedPlan(database: BabmuwonDatabase, yearMonth: '2026-11' | '2026-12', id: string) {
  const plan: MealPlan = { id, yearMonth, status: 'confirmed', confirmedAt: at, sourceFile: 'virtual.xlsx', unknownCount: 0, createdAt: at, updatedAt: at }
  await database.mealPlans.add(plan)
  await database.mealEntries.add(entry(`${id}-entry`, `${yearMonth}-01`, '주찬', '가상 메뉴', 'none_confirmed', [], id))
}
async function seedS4Input(database: BabmuwonDatabase, yearMonth: '2026-11' | '2026-12', suffix: string) {
  if (!await database.students.get('student')) {
    await database.students.add(makeStudent())
    await database.studentAllergies.add({ id: 'student:1', studentId: 'student', allergenNo: 1 })
  }
  const conflict = { ...makeConflict(`conflict-${suffix}`, 'allergen'), date: `${yearMonth}-01`, mealEntryId: `plan-${yearMonth.slice(5)}-entry` }
  await database.conflicts.add(conflict)
  await database.substitutions.add(makeSubstitution(conflict.id, 'confirmed'))
}
function entry(id: string, date: string, slot: string, menuName: string, allergenStatus: MealEntry['allergenStatus'], allergenNos: MealEntry['allergenNos'], mealPlanId = 'plan'): MealEntry { return { id, mealPlanId, date, slot, menuName, allergenStatus, allergenNos, statusSource: 'manual', statusSetAt: at } }
function makeStudent(): Student { return { id: 'student', grade: 1, class: 2, number: 3, alias: '구름-01', needsSubstitute: true, memo: '', createdAt: at, updatedAt: at } }
function makeConflict(id: string, kind: Conflict['kind']): Conflict { return { id, date: '2026-12-01', studentId: 'student', mealEntryId: 'entry', slot: '주찬', menuName: '원 메뉴', kind, allergenNos: kind === 'allergen' ? [1] : [], active: true } }
function makeSubstitution(conflictId: string, status: Substitution['status']): Substitution { return { id: `sub-${conflictId}`, conflictId, substituteName: '가상 대체식', checkedProcessed: true, status, basedOn: { planVersion: 2, studentVersion: 3 }, createdAt: at, updatedAt: at } }
