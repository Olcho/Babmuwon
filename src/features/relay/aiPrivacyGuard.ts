import type { BabmuwonDatabase } from '../../data'

/**
 * 외부 AI(Relay 경유)로 보내는 값에 대한 로컬 개인정보 검사 (명세 R-19~R-21, E3).
 *
 * 백엔드 main은 메뉴명의 공개 식품 목록 대조와 학년·반·전화번호 검사를 제거했고
 * 자료형·빈 값·길이(200자)만 검사한다(IMPLEMENTATION_NOTES). 따라서 이 검사가 유일한 내용 검사이며,
 * 서버 측 차단이 보강·검증되기 전까지는 Mock 모드의 Relay에만 요청을 보낸다.
 */

/** 서버 측 개인정보 차단이 검증되기 전에는 실제 Liner(live) 호출을 켜지 않는다. */
export const ALLOW_LIVE_LINER = false

export type PrivacyBlockReason =
  | 'registered_term' // 등록된 실명·가명·학교/담당자명
  | 'pseudonym_pattern'
  | 'class_pattern'
  | 'phone_pattern'
  | 'email_pattern'
  | 'long_number'
  | 'control_character'
  | 'not_public_menu'

export class PrivacyBlockedError extends Error {
  readonly reason: PrivacyBlockReason
  constructor(reason: PrivacyBlockReason) {
    // 차단된 단어 자체는 오류·기록에 담지 않는다(명세 9-1).
    super(`개인정보로 의심되는 값이 있어 AI 요청을 보내지 않았습니다. (${PRIVACY_REASON_LABEL[reason]})`)
    this.name = 'PrivacyBlockedError'
    this.reason = reason
  }
}

const PRIVACY_REASON_LABEL: Record<PrivacyBlockReason, string> = {
  registered_term: '등록된 이름·학교 정보와 일치',
  pseudonym_pattern: '가명 형식',
  class_pattern: '학년·반·번호 형식',
  phone_pattern: '전화번호 형식',
  email_pattern: '이메일 형식',
  long_number: '긴 숫자열',
  control_character: '줄바꿈·제어 문자',
  not_public_menu: '확정 식단에 없는 메뉴명',
}

const PATTERNS: [RegExp, PrivacyBlockReason][] = [
  // 제어 문자는 의도적으로 검사한다(프롬프트 주입·줄바꿈 차단).
  // oxlint-disable-next-line no-control-regex
  [/[\u0000-\u001f\u007f\u2028\u2029]/, 'control_character'],
  [/[가-힣]{1,8}\s*-\s*\d{2}(?!\d)/, 'pseudonym_pattern'],
  [/\d+\s*학년|\d+\s*반\s*\d+\s*번|\d{1,2}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{1,2}(?!\d)/, 'class_pattern'],
  [/01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}/, 'phone_pattern'],
  [/[^\s@]+@[^\s@]+\.[^\s@]+/, 'email_pattern'],
  [/\d{9,}/, 'long_number'], // 알레르기 번호 표기(5.6.13)는 점으로 구분되어 걸리지 않는다
]

/** 등록된 학생 실명·가명(과거 가명 포함), 학교명, 학교장·담당자명을 차단 단어로 모은다. */
export async function loadPrivacyTerms(database: BabmuwonDatabase): Promise<string[]> {
  const [students, aliases, school] = await Promise.all([
    database.students.toArray(), database.aliasHistories.toArray(), database.schools.get('school'),
  ])
  const terms = [
    ...students.flatMap((student) => [student.alias, student.realName ?? '']),
    ...aliases.map((item) => item.alias),
    school?.name ?? '', school?.principal ?? '', school?.manager ?? '',
  ]
  return [...new Set(terms.map(normalize).filter((term) => term.length >= 2))]
}

/** 값 하나를 검사한다. 문제가 있으면 PrivacyBlockedError를 던진다. */
export function assertPublicText(value: string, terms: readonly string[]): void {
  for (const [pattern, reason] of PATTERNS) if (pattern.test(value)) throw new PrivacyBlockedError(reason)
  const normalized = normalize(value)
  if (terms.some((term) => normalized.includes(term))) throw new PrivacyBlockedError('registered_term')
}

/** 메뉴명 목록 검사: 확정 식단에 있는 이름이어야 하고 개인정보 의심 값이 없어야 한다. */
export function assertPublicMenus(menus: readonly string[], publicMenus: ReadonlySet<string>, terms: readonly string[]): void {
  for (const menu of menus) {
    if (!publicMenus.has(menu)) throw new PrivacyBlockedError('not_public_menu')
    assertPublicText(menu, terms)
  }
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
}
