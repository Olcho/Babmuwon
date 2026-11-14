import * as XLSX from 'xlsx'
import type { LocalDocumentArtifact } from './documentModels'

export function createDocumentWorkbook(document: LocalDocumentArtifact): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new()
  if (document.type === 'S1') {
    const rows = document.rows.map((row) => ({ 날짜: row.date, 요일: row.weekday, ...Object.fromEntries(row.menus.map((menu) => [menu.slot, menu.label])) }))
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), '월간 식단표')
    for (const [index, week] of document.weeks.entries()) {
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(week.rows.map((row) => ({ 날짜: row.date, 요일: row.weekday, ...Object.fromEntries(row.menus.map((menu) => [menu.slot, menu.label])) }))), `${index + 1}주차`)
    }
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(document.legend.map((item) => ({ 번호: item.no, 알레르기유발식품: item.name }))), '알레르기 범례')
  } else if (document.type === 'S3') {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(document.rows.map((row) => ({ 날짜: row.date, 주간: row.weekLabel, 학생: row.studentDisplay, 기존메뉴: row.originalMenu, 대체식: row.substituteMenu, 충돌번호: row.allergenNos.join('.'), 확인사항: row.caution }))), '내부 작업표')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(document.dailyTotals.map((item) => ({ 날짜: item.date, 처리건수: item.count }))), '일자별 합계')
  } else {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['운영 보고', document.reportText], ['알레르기 관리 학생', document.totalStudents], ['대체식 제공', document.providedCount], ['제외 처리', document.excludedCount]]), '운영 보고')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(document.byAllergen.map((item) => ({ 번호: item.allergenNo, 알레르기유발식품: item.name, 학생수: item.students }))), '알레르기별 통계')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(document.byGrade.map((item) => ({ 학년: item.grade, 학생수: item.students }))), '학년별 통계')
  }
  return workbook
}

export function downloadDocumentXlsx(document: LocalDocumentArtifact, version: number): void {
  XLSX.writeFile(createDocumentWorkbook(document), `${document.period}_${document.type}_v${version}.xlsx`)
}
