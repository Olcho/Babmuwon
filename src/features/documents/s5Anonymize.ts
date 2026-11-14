import { SUPPRESSED_COUNT, type RelaySafeCount, type RelayS5BodyRequest } from '../relay/relayClient'
import type { S5Document } from './documentModels'

/** 외부 전송용 값: 3 미만(0·1·2)은 "3명 미만"으로 합친다. */
export function suppressCount(value: number): RelaySafeCount {
  return value < 3 ? SUPPRESSED_COUNT : value
}

/**
 * S5 로컬 통계(정확한 값)를 외부 전송용 비식별 집계로 바꾼다. 로컬 문서 자체는 바꾸지 않는다.
 * 보내는 것은 알레르기 번호별·학년별 인원과 제공·제외 건수뿐이다. 학생 행, 합계(totalStudents), 가명은 포함하지 않는다.
 * 0명도 "3명 미만"으로 포함해 0과 1~2를 구분할 수 없게 한다. 통계적 익명성을 보증하지는 않는다.
 */
export function anonymizeS5Counts(document: S5Document): RelayS5BodyRequest {
  return {
    counts: {
      byAllergen: document.byAllergen.map((item) => ({ allergenNo: item.allergenNo, students: suppressCount(item.students) })),
      byGrade: document.byGrade.map((item) => ({ grade: item.grade, students: suppressCount(item.students) })),
      provided: suppressCount(document.providedCount),
      excluded: suppressCount(document.excludedCount),
    },
  }
}
