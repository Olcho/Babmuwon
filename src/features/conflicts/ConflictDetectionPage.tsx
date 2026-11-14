import { useEffect, useMemo, useState } from 'react'
import type { YearMonth } from '../../data'
import { ALLERGEN_ITEMS } from '../students'
import { allergenNumbersLabel, conflictDetectionService, type ConflictOverview, type ConflictResult } from './conflictDetectionService'

type GroupMode = 'date' | 'student'

export function ConflictDetectionPage() {
  const [overview, setOverview] = useState<ConflictOverview>()
  const [groupMode, setGroupMode] = useState<GroupMode>('date')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { void load() }, [])

  async function load(yearMonth?: YearMonth) {
    setBusy(true)
    setError('')
    try { setOverview(await conflictDetectionService.load(yearMonth)) }
    catch (caught) { setError(caught instanceof Error ? caught.message : '충돌 탐지 결과를 불러오지 못했습니다.') }
    finally { setBusy(false) }
  }

  const groups = useMemo(() => {
    const grouped = new Map<string, ConflictResult[]>()
    for (const result of overview?.results ?? []) {
      const key = groupMode === 'date'
        ? result.conflict.date
        : `${result.student.grade}학년 ${result.student.class}반 ${result.student.number}번 · ${result.student.alias}`
      grouped.set(key, [...(grouped.get(key) ?? []), result])
    }
    return [...grouped.entries()]
  }, [overview, groupMode])

  return (
    <main className="page-shell conflict-page">
      <header className="page-header">
        <div><p className="eyebrow">SC-05</p><h1>알레르기 충돌 자동 탐지</h1><p>확정 식단과 이 기기의 학생 알레르기 번호만 비교합니다. AI와 외부 서버는 사용하지 않습니다.</p></div>
        <button type="button" disabled={busy} onClick={() => void load(overview?.selectedPlan?.yearMonth)}>{busy ? '탐지 중…' : '최신 데이터로 다시 탐지'}</button>
      </header>
      {error && <p className="error-panel" role="alert">{error}</p>}
      <p className="safety-notice">번호상 충돌이 없더라도 실제 섭취 안전을 보장하지 않습니다. 제품 표시, 원재료와 교차오염 가능성을 별도로 확인하세요.</p>

      {overview && overview.state !== 'ready' ? <EmptyState state={overview.state} /> : overview && (
        <>
          <section className="conflict-toolbar">
            <label>확정 식단 월<select value={overview.selectedPlan?.yearMonth} onChange={(event) => void load(event.target.value as YearMonth)}>{overview.plans.map((plan) => <option key={plan.id} value={plan.yearMonth}>{plan.yearMonth}</option>)}</select></label>
            <div className="group-buttons"><span>보기 기준</span><button type="button" className={groupMode === 'date' ? 'active' : ''} onClick={() => setGroupMode('date')}>날짜별</button><button type="button" className={groupMode === 'student' ? 'active' : ''} onClick={() => setGroupMode('student')}>학생별</button></div>
          </section>
          <section className="conflict-summary" aria-label="탐지 요약">
            <div><span>번호 충돌</span><strong>{overview.conflictCount}건</strong></div>
            <div className={overview.unknownCount > 0 ? 'warning-stat' : ''}><span>확인 필요</span><strong>{overview.unknownCount}건</strong></div>
            <div><span>영향 학생</span><strong>{overview.affectedStudentCount}명</strong></div>
            <div><span>전체 탐지 결과</span><strong>{overview.results.length}건</strong></div>
          </section>
          {overview.unknownCount > 0 && <p className="warning" role="alert">미확인 메뉴가 포함되어 있습니다. 해당 날짜의 알레르기 보유 학생은 모두 ‘확인 필요’로 표시됩니다.</p>}
          {groups.length === 0 ? <section className="empty-state"><h2>번호상 탐지된 결과가 없습니다</h2><p>이는 실제 섭취 안전을 보장하지 않습니다. 메뉴와 제품 표시를 계속 확인해 주세요.</p></section> : (
            <div className="conflict-groups">{groups.map(([key, results]) => (
              <section className="conflict-group" key={key}>
                <h2>{key} <span>{results.length}</span></h2>
                <div className="conflict-cards">{results.map((result) => <ConflictCard key={result.conflict.id} result={result} groupMode={groupMode} />)}</div>
              </section>
            ))}</div>
          )}
        </>
      )}
    </main>
  )
}

function ConflictCard({ result, groupMode }: { result: ConflictResult; groupMode: GroupMode }) {
  const { conflict, student, substitution } = result
  const names = conflict.allergenNos.map((no) => ALLERGEN_ITEMS.find((item) => item.no === no)?.name ?? String(no)).join(', ')
  return (
    <article className={conflict.kind === 'unknown_menu' ? 'conflict-card unknown-result' : 'conflict-card'}>
      <div className="conflict-card-heading"><span className={conflict.kind === 'unknown_menu' ? 'status warning-status' : 'status conflict-status'}>{conflict.kind === 'unknown_menu' ? '확인 필요' : '번호 충돌'}</span><strong>{conflict.menuName}</strong></div>
      <dl>
        {groupMode === 'student' ? <><dt>날짜</dt><dd>{conflict.date}</dd></> : <><dt>학생</dt><dd>{student.grade}학년 {student.class}반 {student.number}번 · {student.alias}</dd></>}
        <dt>슬롯</dt><dd>{conflict.slot ?? '—'}</dd>
        <dt>{conflict.kind === 'unknown_menu' ? '학생 알레르기' : '충돌 번호'}</dt><dd>{allergenNumbersLabel(conflict.allergenNos)} · {names}</dd>
        <dt>대체식 상태</dt><dd>{substitutionStatusLabel(substitution?.status)}</dd>
      </dl>
      {conflict.kind === 'unknown_menu' && <p>메뉴 알레르기 정보가 미확인입니다. SC-04에서 번호를 입력하거나 ‘해당 없음 확인’을 완료하세요.</p>}
    </article>
  )
}

function substitutionStatusLabel(status?: ConflictResult['substitution'] extends infer T ? T extends { status: infer S } ? S : never : never): string {
  if (!status) return '미생성'
  return {
    pending: '미확정', confirmed: '확정', excludeOnly: '대체식 불필요·제외만',
    needs_review: '재검토 필요', obsolete: '더 이상 해당 없음',
  }[status]
}

function EmptyState({ state }: { state: ConflictOverview['state'] }) {
  const content = {
    no_meal_plan: ['저장된 식단이 없습니다', 'SC-04에서 엑셀 식단을 먼저 불러와 주세요.'],
    not_confirmed: ['확정된 식단이 없습니다', 'SC-04에서 식단을 확정해야 충돌 탐지를 시작할 수 있습니다.'],
    no_students: ['등록된 학생이 없습니다', 'SC-03에서 알레르기 보유 학생을 먼저 등록해 주세요.'],
    ready: ['', ''],
  }[state]
  return <section className="empty-state"><h2>{content[0]}</h2><p>{content[1]}</p></section>
}
