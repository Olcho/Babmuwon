import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import type { MealEntry, MealPlan } from './data'
import { mealPlanService, parseAllergenValue, parseMealWorkbook, type MealPlanParseIssue, type StoredMealPlan } from './features/meal-plan'
import { StudentAllergyPage } from './features/students/StudentAllergyPage'
import { ConflictDetectionPage } from './features/conflicts/ConflictDetectionPage'
import './App.css'

function allergenLabel(entry: MealEntry): string {
  if (entry.allergenStatus === 'unknown') return ''
  if (entry.allergenStatus === 'none_confirmed') return '없음'
  return entry.allergenNos.join('.')
}

function MealPlanPage() {
  const [stored, setStored] = useState<StoredMealPlan>()
  const [issues, setIssues] = useState<MealPlanParseIssue[]>([])
  const [missingHeaders, setMissingHeaders] = useState<string[]>([])
  const [unknownOnly, setUnknownOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [editErrors, setEditErrors] = useState<Record<string, string>>({})

  useEffect(() => { void mealPlanService.getLatest().then(setStored) }, [])

  const visibleEntries = useMemo(
    () => stored?.entries.filter((entry) => !unknownOnly || entry.allergenStatus === 'unknown') ?? [],
    [stored, unknownOnly],
  )
  const dates = useMemo(() => [...new Set(visibleEntries.map((entry) => entry.date))].sort(), [visibleEntries])
  const slots = useMemo(() => [...new Set(visibleEntries.map((entry) => entry.slot))], [visibleEntries])

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true)
    setMessage('')
    try {
      const result = parseMealWorkbook(await file.arrayBuffer())
      setIssues(result.issues)
      setMissingHeaders(result.missingHeaders)
      if (!result.yearMonth || result.rows.length === 0 || result.missingHeaders.length > 0) return
      const existing = await mealPlanService.getByMonth(result.yearMonth)
      if (existing && !window.confirm(`${result.yearMonth} 식단이 이미 있습니다. 기존 식단을 덮어쓰고 확정을 해제할까요?`)) return
      const next = await mealPlanService.saveUpload(result, file.name)
      setStored(next)
      setMessage(`${next.entries.length}개 메뉴를 브라우저에 저장했습니다.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '엑셀 파일을 읽지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  async function updateAllergens(entry: MealEntry, rawValue: string) {
    if (!stored || stored.plan.status === 'confirmed') return
    const parsed = parseAllergenValue(rawValue)
    if (parsed.error) {
      setEditErrors((current) => ({ ...current, [entry.id]: parsed.error ?? '' }))
      return
    }
    setEditErrors((current) => {
      const next = { ...current }
      delete next[entry.id]
      return next
    })
    const nextEntry: MealEntry = {
      ...entry,
      allergenStatus: parsed.status,
      allergenNos: parsed.allergenNos,
      statusSource: 'manual',
      statusSetAt: new Date().toISOString(),
    }
    setStored(await mealPlanService.saveEntry(stored.plan, nextEntry))
  }

  async function toggleConfirmation(plan: MealPlan) {
    setBusy(true)
    setMessage('')
    try {
      if (plan.status === 'confirmed') {
        setStored(await mealPlanService.unconfirm(plan))
        setMessage('확정을 해제했습니다. 다시 확정하기 전까지 후속 업무는 잠금 대상입니다.')
      } else {
        const unknownCount = stored?.plan.unknownCount ?? 0
        if (unknownCount > 0 && !window.confirm(`미확인 메뉴가 ${unknownCount}개 있습니다. 탐지 결과가 불완전할 수 있습니다. 그래도 확정할까요?`)) return
        setStored(await mealPlanService.confirm(plan))
        setMessage('식단을 확정했습니다. 식단 버전이 증가하고 기존 대체식·문서는 재검토 대상으로 변경됩니다.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="page-shell">
      <header className="page-header">
        <div><p className="eyebrow">SC-04</p><h1>엑셀 식단 불러오기·확정</h1><p>파일은 이 브라우저 안에서만 처리되며 외부 서버로 전송되지 않습니다.</p></div>
        <label className="upload-button">{busy ? '처리 중…' : '엑셀 파일 선택'}<input type="file" accept=".xlsx" onChange={handleFile} disabled={busy} /></label>
      </header>

      {message && <p className="notice" role="status">{message}</p>}
      {missingHeaders.length > 0 && <section className="error-panel" aria-live="polite"><h2>필수 열을 찾을 수 없습니다</h2><p>누락: {missingHeaders.join(', ')}</p></section>}

      {stored ? (
        <>
          <section className="summary" aria-label="식단 상태">
            <div><span>대상 월</span><strong>{stored.plan.yearMonth}</strong></div>
            <div><span>상태</span><strong>{stored.plan.status === 'confirmed' ? '확정' : '작성 중'}</strong></div>
            <div><span>원본 파일</span><strong>{stored.plan.sourceFile}</strong></div>
            <div className={stored.plan.unknownCount > 0 ? 'warning-stat' : ''}><span>미확인 메뉴</span><strong>{stored.plan.unknownCount}개</strong></div>
          </section>
          {stored.plan.unknownCount > 0 && <p className="warning" role="alert">미확인 메뉴 {stored.plan.unknownCount}개 — 알레르기 탐지 결과가 불완전합니다.</p>}

          <section className="preview-section">
            <div className="section-heading">
              <div><h2>식단 미리보기</h2><p>작성 중일 때 번호를 수정하거나 해당 없음으로 확인할 수 있습니다.</p></div>
              <label className="filter"><input type="checkbox" checked={unknownOnly} onChange={(event) => setUnknownOnly(event.target.checked)} /> 미확인만 보기</label>
            </div>
            <div className="table-scroll">
              <table className="meal-grid">
                <thead><tr><th>날짜</th>{slots.map((slot) => <th key={slot}>{slot}</th>)}</tr></thead>
                <tbody>{dates.map((date) => (
                  <tr key={date}>
                    <th>{date}</th>
                    {slots.map((slot) => {
                      const entry = visibleEntries.find((item) => item.date === date && item.slot === slot)
                      if (!entry) return <td key={slot} className="empty-cell">—</td>
                      return (
                        <td key={slot} className={entry.allergenStatus === 'unknown' ? 'unknown-cell' : ''}>
                          <strong>{entry.menuName}</strong>
                          <div className="allergen-editor">
                            <label><span>알레르기 번호</span><input key={`${entry.id}:${allergenLabel(entry)}`} defaultValue={allergenLabel(entry)} placeholder="미확인" disabled={stored.plan.status === 'confirmed'} onBlur={(event) => void updateAllergens(entry, event.target.value)} /></label>
                            <button type="button" disabled={stored.plan.status === 'confirmed'} onClick={() => void updateAllergens(entry, '없음')}>해당 없음 확인</button>
                          </div>
                          {editErrors[entry.id] && <small className="field-error">{editErrors[entry.id]}</small>}
                          <small className="status-label">{entry.allergenStatus === 'listed' ? '번호 표기' : entry.allergenStatus === 'none_confirmed' ? '해당 없음 확인됨' : '미확인'}</small>
                        </td>
                      )
                    })}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>

          <div className="confirmation-bar">
            <p>{stored.plan.status === 'confirmed' ? '확정된 식단은 잠겨 있습니다. 수정하려면 확정을 해제하세요.' : '확정하면 planVersion이 증가하고 후속 재검토 상태가 반영됩니다.'}</p>
            <button type="button" className={stored.plan.status === 'confirmed' ? 'secondary' : 'primary'} disabled={busy} onClick={() => void toggleConfirmation(stored.plan)}>{stored.plan.status === 'confirmed' ? '확정 해제' : '식단 확정'}</button>
          </div>
        </>
      ) : <section className="empty-state"><h2>저장된 식단이 없습니다</h2><p>날짜, 슬롯, 메뉴명, 알레르기 번호 열이 있는 .xlsx 파일을 선택해 주세요.</p></section>}

      {issues.length > 0 && (
        <section className="issues-section">
          <h2>가져오지 못한 항목 <span>{issues.length}</span></h2>
          <div className="table-scroll"><table><thead><tr><th>행</th><th>항목</th><th>입력값</th><th>오류</th></tr></thead><tbody>
            {issues.map((issue, index) => <tr key={`${issue.row}-${issue.field}-${index}`}><td>{issue.row}</td><td>{issue.field}</td><td>{String(issue.value ?? '')}</td><td>{issue.message}</td></tr>)}
          </tbody></table></div>
        </section>
      )}
    </main>
  )
}

function App() {
  const [screen, setScreen] = useState<'students' | 'meals' | 'conflicts'>('students')
  return (
    <>
      <nav className="screen-nav" aria-label="업무 화면">
        <strong>밥무원</strong>
        <div><button type="button" className={screen === 'students' ? 'active' : ''} onClick={() => setScreen('students')}>학생 알레르기 등록</button><button type="button" className={screen === 'meals' ? 'active' : ''} onClick={() => setScreen('meals')}>식단 불러오기·확정</button><button type="button" className={screen === 'conflicts' ? 'active' : ''} onClick={() => setScreen('conflicts')}>알레르기 충돌 탐지</button></div>
      </nav>
      {screen === 'students' ? <StudentAllergyPage /> : screen === 'meals' ? <MealPlanPage /> : <ConflictDetectionPage />}
    </>
  )
}

export default App
