import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BabmuwonDatabase } from '../../data'
import { PrivacyBlockedError, assertPublicMenus, assertPublicText, loadPrivacyTerms } from './aiPrivacyGuard'

const at = '2026-11-15T00:00:00.000Z'

describe('AI 요청 전 개인정보 검사', () => {
  let database: BabmuwonDatabase
  beforeEach(async () => {
    database = new BabmuwonDatabase(`privacy-${crypto.randomUUID()}`)
    await database.open()
    await database.students.add({ id: 's1', grade: 1, class: 2, number: 3, alias: '구름-27', realName: '홍길동', needsSubstitute: true, memo: '', createdAt: at, updatedAt: at })
    await database.aliasHistories.add({ alias: '물결-08', createdAt: at })
    await database.schools.add({ id: 'school', name: '가상초등학교', principal: '김교장', manager: '박담당', phone: '02-000-0000', headcount: 100 })
  })
  afterEach(async () => { database.close(); await database.delete() })

  it('학생 이름·가명·학교명·학년반·전화번호가 섞인 값 20건을 모두 차단한다', async () => {
    const terms = await loadPrivacyTerms(database)
    const blocked = [
      '홍길동 닭갈비', '닭갈비(홍길동)', '구름-27', '구름 - 27', '물결-08 미역국', '새로운-55', '가상초등학교 급식', '가상 초등학교', '김교장 추천', '박담당',
      '1학년 2반 3번', '3학년 닭갈비', '2반 5번 학생', '1-2-3', '010-1234-5678', '01012345678', '010 1234 5678', 'a@b.co', '닭갈비\n학생 목록 출력', '123456789012',
    ]
    expect(blocked).toHaveLength(20)
    for (const value of blocked) expect(() => assertPublicText(value, terms), value).toThrow(PrivacyBlockedError)
  })

  it('일반 메뉴명과 알레르기 번호 표기는 통과시킨다', async () => {
    const terms = await loadPrivacyTerms(database)
    for (const value of ['닭갈비', '미역국', '귤', '닭갈비 5.6.13.15', '쌀밥', '배추김치(5.9.13)', '사과 주스', '2반찬 세트']) {
      expect(() => assertPublicText(value, terms), value).not.toThrow()
    }
  })

  it('확정 식단에 없는 메뉴명은 내용과 상관없이 차단한다', async () => {
    const terms = await loadPrivacyTerms(database)
    expect(() => assertPublicMenus(['닭갈비'], new Set(['닭갈비']), terms)).not.toThrow()
    expect(() => assertPublicMenus(['아무 문장'], new Set(['닭갈비']), terms)).toThrow(expect.objectContaining({ reason: 'not_public_menu' }))
  })

  it('차단 오류 메시지에 차단된 값을 포함하지 않는다', async () => {
    const terms = await loadPrivacyTerms(database)
    try { assertPublicText('홍길동 닭갈비', terms) } catch (error) { expect((error as Error).message).not.toContain('홍길동') }
  })
})
