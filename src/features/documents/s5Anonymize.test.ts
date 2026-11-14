import { describe, expect, it, vi } from 'vitest'
import { RelayClient } from '../relay/relayClient'
import { buildS5Document } from './documentBuilders'
import { anonymizeS5Counts, suppressCount } from './s5Anonymize'

const at = '2026-11-15T00:00:00.000Z'
const version = { id: 'current' as const, planVersion: 1, studentVersion: 1, substitutionVersion: 1, updatedAt: at }
const student = (n: number, grade: number) => ({ id: `s${n}`, grade, class: 1, number: n, alias: `구름-0${n}`, realName: `실명${n}`, needsSubstitute: true, memo: '민감 메모', createdAt: at, updatedAt: at })

describe('S5 외부 전송용 비식별 집계', () => {
  it('0·1·2는 "3명 미만"으로 합치고 3 이상은 정확한 값을 유지한다', () => {
    expect([0, 1, 2, 3, 4, 100].map(suppressCount)).toEqual(['3명 미만', '3명 미만', '3명 미만', 3, 4, 100])
  })

  it('로컬 문서의 정확한 통계는 그대로 두고 전송용 집계만 억제한다', () => {
    const students = [student(1, 1), student(2, 1), student(3, 1), student(4, 2)]
    const allergies = [1, 2, 3].map((n) => ({ id: `a${n}`, studentId: `s${n}`, allergenNo: 1 as const })).concat([{ id: 'a4', studentId: 's4', allergenNo: 5 as never }])
    const document = buildS5Document('2026', students, allergies, [], [], version, at)
    const local = structuredClone(document)
    const { counts } = anonymizeS5Counts(document)

    expect(document).toEqual(local) // 변환이 로컬 문서를 바꾸지 않는다
    expect(document.byAllergen.find((item) => item.allergenNo === 5)?.students).toBe(1) // 로컬은 정확한 값
    expect(counts.byAllergen.find((item) => item.allergenNo === 1)?.students).toBe(3)
    expect(counts.byAllergen.find((item) => item.allergenNo === 5)?.students).toBe('3명 미만')
    expect(counts.byAllergen.find((item) => item.allergenNo === 7)?.students).toBe('3명 미만') // 0명도 구분되지 않는다
    expect(counts.byAllergen).toHaveLength(19)
    expect(counts.byGrade).toEqual([{ grade: 1, students: 3 }, { grade: 2, students: '3명 미만' }])
    expect(counts.provided).toBe('3명 미만')
    expect(counts.excluded).toBe('3명 미만')
  })

  it('학생 행·가명·실명·메모·합계는 포함하지 않고 Relay 클라이언트 검증을 통과한다', async () => {
    const students = [student(1, 1), student(2, 1), student(3, 1)]
    const allergies = students.map((item, index) => ({ id: `a${index}`, studentId: item.id, allergenNo: 1 as const }))
    const document = buildS5Document('2026', students, allergies, [], [], version, at)
    const body = anonymizeS5Counts(document)
    const text = JSON.stringify(body)
    for (const forbidden of ['구름', '실명', '민감', 'totalStudents', 'studentId', 's1']) expect(text).not.toContain(forbidden)
    expect(Object.keys(body)).toEqual(['counts'])

    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ text: 't', citations: [], simulated: true, cached: false, reviewRequired: true, sourceMissing: true, source: 'mock' })))
    const client = new RelayClient({ fetcher }); client.configure('http://127.0.0.1:3000', 'token')
    await expect(client.s5Body(body)).resolves.toMatchObject({ text: 't' })
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual(body)
  })
})
