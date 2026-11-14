import * as XLSX from 'xlsx'

/** SC-04 '템플릿 받기': 명세 4-2 엑셀 양식(날짜·슬롯·메뉴명·알레르기 번호)과 표기법 안내. 파서(REQUIRED_HEADERS)와 같은 머리글을 쓴다. */
export function createMealTemplateWorkbook(): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['날짜', '슬롯', '메뉴명', '알레르기 번호'],
    ['2026-12-01', '밥', '잡곡밥', '없음'],
    ['2026-12-01', '국', '미역국', '5.6.9'],
    ['2026-12-01', '주찬', '닭갈비', '5.6.13.15'],
    ['2026-12-01', '부찬', '숙주무침', '5'],
    ['2026-12-01', '김치', '배추김치', '9'],
    ['2026-12-01', '후식', '귤', '-'],
  ]), '식단')
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['표기법'],
    ['첫 시트의 첫 행은 머리글입니다: 날짜, 슬롯, 메뉴명, 알레르기 번호'],
    ['알레르기 번호는 1~19를 점·쉼표·공백으로 구분합니다. 예) 5.6.13'],
    ["'-' 또는 '없음'은 확인된 해당 없음, 빈 칸은 미확인(노란색 표시)입니다."],
    ['번호 칸이 비어 있고 메뉴명 끝에 번호가 붙어 있으면(예: 닭갈비 5.6.13) 자동으로 분리합니다.'],
    ['한 파일에는 같은 달의 식단만 넣어 주세요.'],
  ]), '표기법')
  return workbook
}

export function downloadMealTemplate(): void {
  XLSX.writeFile(createMealTemplateWorkbook(), '밥무원_식단_템플릿.xlsx')
}
