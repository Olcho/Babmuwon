import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import fileIcon from '../../assets/figma/icon-file.svg'
import type { MealEntry, MealPlan, YearMonth } from '../../data'
import { s2StateSync } from '../relay/s2StateSync'
import { Badge, Button, Notice, PageHeader } from '../../ui'
import { parseAllergenValue, parseMealWorkbook, type MealPlanParseIssue } from './mealPlanParser'
import { mealPlanService, type StoredMealPlan } from './mealPlanService'
import { downloadMealTemplate } from './mealPlanTemplate'

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

/** SC-04 식단 불러오기·확정 (Figma Frame 38). 로직은 mealPlanService·파서를 그대로 쓴다. */
export function MealPlanPage() {
  const [plans, setPlans] = useState<MealPlan[]>([])
  const [stored, setStored] = useState<StoredMealPlan>()
  const [issues, setIssues] = useState<MealPlanParseIssue[]>([])
  const [missingHeaders, setMissingHeaders] = useState<string[]>([])
  const [unknownOnly, setUnknownOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [editErrors, setEditErrors] = useState<Record<string, string>>({})
  const fileInput = useRef<HTMLInputElement>(null)

  async function load(month?: YearMonth) {
    const list = await mealPlanService.listPlans()
    setPlans(list)
    const target = month ?? list[0]?.yearMonth
    setStored(target ? await mealPlanService.getByMonth(target) : undefined)
  }
  // IndexedDB는 외부 저장소이므로 화면을 열 때 한 번 불러온다.
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void load() }, [])

  const weeks = useMemo(() => groupWeeks(stored?.entries ?? []), [stored])
  const slots = useMemo(() => [...new Set((stored?.entries ?? []).map((entry) => entry.slot))], [stored])
  const confirmed = stored?.plan.status === 'confirmed'
  const days = new Set((stored?.entries ?? []).map((entry) => entry.date)).size

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true); setMessage('')
    try {
      const result = parseMealWorkbook(await file.arrayBuffer())
      setIssues(result.issues); setMissingHeaders(result.missingHeaders)
      if (!result.yearMonth || result.rows.length === 0 || result.missingHeaders.length > 0) return
      const existing = await mealPlanService.getByMonth(result.yearMonth)
      if (existing && !window.confirm(`${result.yearMonth} 식단이 이미 있습니다. 기존 식단을 덮어쓰고 확정을 해제할까요?\n다시 확정하면 영향받은 대체식과 문서는 재검토 대상으로 바뀝니다.`)) return
      const next = await mealPlanService.saveUpload(result, file.name)
      await load(next.plan.yearMonth)
      setMessage(`${next.entries.length}개 메뉴를 이 브라우저에 저장했습니다.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '엑셀 파일을 읽지 못했습니다.')
    } finally { setBusy(false) }
  }

  async function updateAllergens(entry: MealEntry, rawValue: string) {
    if (!stored || confirmed) return
    const parsed = parseAllergenValue(rawValue)
    if (parsed.error) { setEditErrors((current) => ({ ...current, [entry.id]: parsed.error ?? '' })); return }
    setEditErrors((current) => { const next = { ...current }; delete next[entry.id]; return next })
    setStored(await mealPlanService.saveEntry(stored.plan, {
      ...entry, allergenStatus: parsed.status, allergenNos: parsed.allergenNos, statusSource: 'manual', statusSetAt: new Date().toISOString(),
    }))
  }

  async function toggleConfirmation() {
    if (!stored) return
    const plan = stored.plan
    setBusy(true); setMessage('')
    try {
      if (plan.status === 'confirmed') {
        await mealPlanService.unconfirm(plan)
        const sync = await s2StateSync.syncMonth(plan.yearMonth)
        setMessage(`확정을 해제했습니다. 다시 확정하기 전까지 대체식·문서·발송이 잠깁니다.${syncNotice(sync)}`)
      } else {
        if (plan.unknownCount > 0 && !window.confirm(`미확인 메뉴 ${plan.unknownCount}개 — 알레르기 탐지 결과가 불완전합니다.\n그래도 확정할까요?`)) return
        await mealPlanService.confirm(plan)
        const sync = await s2StateSync.syncMonth(plan.yearMonth)
        setMessage(`식단을 확정했습니다. 식단 버전이 올라가고 영향받은 대체식·문서는 재검토 대상으로 바뀝니다.${syncNotice(sync)}`)
      }
      await load(plan.yearMonth)
    } finally { setBusy(false) }
  }

  return <div className="page stack">
    <PageHeader title="식단 불러오기·확정" actions={<>
      <Button size="lg" onClick={downloadMealTemplate}>탬플릿 받기</Button>
      <Button size="lg" variant="primary" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? '처리 중…' : '엑셀 올리기'}</Button>
      <input ref={fileInput} className="sr-only" type="file" accept=".xlsx" onChange={handleFile} aria-label="식단 엑셀 파일" />
    </>} />

    <Notice>파일은 이 브라우저 안에서만 처리되며 외부 서버로 전송되지 않습니다.</Notice>
    {message && <Notice tone="success">{message}</Notice>}
    {missingHeaders.length > 0 && <Notice tone="danger">필수 열을 찾을 수 없습니다: {missingHeaders.join(', ')}</Notice>}

    {stored ? <>
      <div className="file-bar">
        <div className="row" style={{ gap: 40 }}>
          <span className="file-bar__name"><img src={fileIcon} alt="" width={36} height={36} />{stored.plan.sourceFile}</span>
          <span className="file-bar__meta">{stored.plan.yearMonth}  ·  급식일 {days}일  ·  메뉴 {stored.entries.length}개 읽음</span>
          <Badge tone={confirmed ? 'primary' : 'neutral'}>{confirmed ? '확정됨' : '작성 중'}</Badge>
        </div>
        <div className="row">
          {plans.length > 1 && <select className="ds-input" style={{ width: 'auto', padding: '8px 12px', fontSize: 15 }} value={stored.plan.yearMonth} onChange={(event) => void load(event.target.value as YearMonth)} aria-label="식단 월">{plans.map((plan) => <option key={plan.id} value={plan.yearMonth}>{plan.yearMonth}</option>)}</select>}
          {issues.length > 0 && <span className="file-bar__error">형식 오류 {issues.length}행</span>}
          {stored.plan.unknownCount > 0 && <span className="file-bar__error">미확인 메뉴 {stored.plan.unknownCount}개</span>}
        </div>
      </div>
      {stored.plan.unknownCount > 0 && <Notice tone="warning" role="alert">미확인 메뉴 {stored.plan.unknownCount}개 — 알레르기 탐지 결과가 불완전합니다. 노란 칸에서 번호를 입력하거나 ‘해당 없음 확인’을 눌러 주세요.</Notice>}
      <div className="row row--between">
        <label className="check"><input type="checkbox" checked={unknownOnly} onChange={(event) => setUnknownOnly(event.target.checked)} /> 미확인만 보기</label>
        <span className="subtle">{confirmed ? '확정된 식단은 잠겨 있습니다. 수정하려면 확정을 해제하세요.' : '작성 중에는 칸에서 알레르기 번호를 고칠 수 있습니다.'}</span>
      </div>

      {weeks.map((week) => <section key={week.label} className="stack" style={{ gap: 12 }}>
        <p className="week-label">{week.label}</p>
        <div className="day-columns">
          {week.days.map((day) => {
            const entries = (day.entries ?? []).filter((entry) => !unknownOnly || entry.allergenStatus === 'unknown')
            return <div key={day.date} className={`day-col${day.entries ? '' : ' day-col--empty'}`}>
              <div className="day-col__head"><strong>{day.date.slice(5).replace('-', '/')}</strong><span className="day-col__weekday">{WEEKDAYS[new Date(`${day.date}T00:00:00`).getDay()]}</span></div>
              {!day.entries && <span className="subtle">급식 없음</span>}
              {slots.map((slot) => entries.filter((entry) => entry.slot === slot).map((entry) => <div key={entry.id} className={`meal-slot${entry.allergenStatus === 'unknown' ? ' meal-slot--unknown' : ''}`}>
                <span className="meal-slot__label">{slot}</span>
                <span className="meal-slot__name">{entry.menuName} {entry.allergenStatus === 'listed' ? entry.allergenNos.join('.') : entry.allergenStatus === 'none_confirmed' ? '' : '(미확인)'}</span>
                {!confirmed && (entry.allergenStatus === 'unknown' || editErrors[entry.id]) && <div className="meal-slot__edit">
                  <input key={`${entry.id}:${entry.allergenNos.join('.')}`} placeholder="번호 예) 5.6" aria-label={`${entry.menuName} 알레르기 번호`} onBlur={(event) => { if (event.target.value.trim()) void updateAllergens(entry, event.target.value) }} />
                  <button type="button" onClick={() => void updateAllergens(entry, '없음')}>해당 없음 확인</button>
                </div>}
                {editErrors[entry.id] && <span className="meal-slot__error">{editErrors[entry.id]}</span>}
              </div>))}
            </div>
          })}
        </div>
      </section>)}

      <div className="row row--end">
        <Button size="lg" variant={confirmed ? 'secondary' : 'primary'} disabled={busy} onClick={() => void toggleConfirmation()}>{confirmed ? '확정 해제' : '확정'}</Button>
      </div>
    </> : <div className="empty"><strong>저장된 식단이 없습니다</strong>날짜, 슬롯, 메뉴명, 알레르기 번호 열이 있는 .xlsx 파일을 올려 주세요. ‘탬플릿 받기’로 양식을 받을 수 있습니다.</div>}

    {issues.length > 0 && <section className="stack" style={{ gap: 16 }}>
      <h2 style={{ fontSize: 24 }}>가져오지 못한 항목 <Badge tone="danger">{issues.length}</Badge></h2>
      <div className="ds-table-wrap"><table className="ds-table"><thead><tr><th>행</th><th>항목</th><th>입력값</th><th>오류</th></tr></thead><tbody>
        {issues.map((issue, index) => <tr key={`${issue.row}-${issue.field}-${index}`}><td>{issue.row}</td><td>{issue.field}</td><td>{String(issue.value ?? '')}</td><td>{issue.message}</td></tr>)}
      </tbody></table></div>
    </section>}
  </div>
}

function syncNotice(outcome: { status: string; message: string }): string {
  return outcome.status === 'failed' ? ` S2 Relay 동기화 실패: ${outcome.message}` : outcome.status === 'synced' ? ' S2 상태를 Relay에 동기화했습니다.' : ''
}

/** 날짜를 주(월~금) 단위로 묶는다. 주말 급식이 있으면 그 주에 함께 보인다. */
function groupWeeks(entries: MealEntry[]) {
  const byDate = new Map<string, MealEntry[]>()
  for (const entry of entries) byDate.set(entry.date, [...(byDate.get(entry.date) ?? []), entry])
  const weeks = new Map<string, { label: string; days: { date: string; entries?: MealEntry[] }[] }>()
  for (const date of [...byDate.keys()].sort()) {
    const day = new Date(`${date}T00:00:00`)
    const monday = new Date(day); monday.setDate(day.getDate() - ((day.getDay() + 6) % 7))
    const key = iso(monday)
    if (!weeks.has(key)) {
      const days = Array.from({ length: 5 }, (_, index) => { const d = new Date(monday); d.setDate(monday.getDate() + index); return { date: iso(d) } })
      weeks.set(key, { label: `${key.slice(5).replace('-', '/')} 주`, days })
    }
    const week = weeks.get(key)!
    const slot = week.days.find((item) => item.date === date)
    if (slot) slot.entries = byDate.get(date)
    else week.days.push({ date, entries: byDate.get(date) })
  }
  return [...weeks.values()].map((week) => ({ ...week, days: week.days.filter((day) => day.entries || day.date.slice(0, 7) === [...byDate.keys()][0]?.slice(0, 7)) }))
}

function iso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
