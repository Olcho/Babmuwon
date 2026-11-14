import { useEffect, useMemo, useState } from 'react'
import type { AllergenNo, YearMonth } from '../../data'
import { parseAllergenValue } from '../meal-plan'
import { ALLERGEN_ITEMS } from '../students'
import {
  substitutionService,
  type SubstitutionItem,
  type SubstitutionOverview,
  type SubstitutionSelection,
} from './substitutionService'

type GroupMode = 'date' | 'student'
interface Draft {
  candidateKey?: string
  directName: string
  directAllergens: string
  checked: boolean
  mode: 'recommended' | 'manual'
}

export function SubstitutionPage() {
  const [overview, setOverview] = useState<SubstitutionOverview>()
  const [groupMode, setGroupMode] = useState<GroupMode>('date')
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busyId, setBusyId] = useState<string>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => { void load() }, [])

  async function load(yearMonth?: YearMonth) {
    setError('')
    try {
      const next = await substitutionService.load(yearMonth)
      setOverview(next)
      setDrafts((current) => {
        const merged = { ...current }
        for (const item of next.items) if (!merged[item.conflict.id]) {
          merged[item.conflict.id] = {
            directName: item.substitution.selectionSource === 'manual' ? item.substitution.substituteName ?? '' : '',
            directAllergens: item.substitution.selectionSource === 'manual'
              ? item.substitution.substituteAllergenStatus === 'none_confirmed' ? '없음' : item.substitution.substituteAllergenNos?.join('.') ?? ''
              : '',
            candidateKey: item.substitution.selectionSource === 'recommended'
              ? item.candidates.find((candidate) => candidate.name === item.substitution.substituteName)?.key
              : undefined,
            checked: item.substitution.checkedProcessed,
            mode: item.substitution.selectionSource ?? 'recommended',
          }
        }
        return merged
      })
    } catch (caught) { setError(caught instanceof Error ? caught.message : '대체식 정보를 불러오지 못했습니다.') }
  }

  const groups = useMemo(() => {
    const result = new Map<string, SubstitutionItem[]>()
    for (const item of overview?.items ?? []) {
      const key = groupMode === 'date' ? item.conflict.date : `${item.student.grade}학년 ${item.student.class}반 ${item.student.number}번 · ${item.student.alias}`
      result.set(key, [...(result.get(key) ?? []), item])
    }
    return [...result.entries()]
  }, [overview, groupMode])

  function updateDraft(id: string, change: Partial<Draft>) {
    setDrafts((current) => {
      const previous = current[id] ?? { candidateKey: undefined, directName: '', directAllergens: '', checked: false, mode: 'recommended' as const }
      return { ...current, [id]: { ...previous, ...change } }
    })
  }

  async function confirm(item: SubstitutionItem) {
    const draft = drafts[item.conflict.id]
    if (!draft) return
    setBusyId(item.conflict.id)
    setError('')
    setMessage('')
    try {
      let selection: SubstitutionSelection
      if (draft.mode === 'recommended') {
        const candidate = item.candidates.find((value) => value.key === draft.candidateKey)
        if (!candidate) throw new Error('추천 후보를 선택해 주세요.')
        selection = { name: candidate.name, allergenStatus: candidate.allergenStatus, allergenNos: candidate.allergenNos, source: 'recommended' }
      } else {
        const parsed = parseAllergenValue(draft.directAllergens)
        if (parsed.error || parsed.status === 'unknown') throw new Error(parsed.error ?? '직접 입력 메뉴의 알레르기 번호 또는 해당 없음을 확인해 주세요.')
        selection = { name: draft.directName, allergenStatus: parsed.status, allergenNos: parsed.allergenNos, source: 'manual' }
      }
      await substitutionService.confirm(item.conflict.id, selection, draft.checked)
      setMessage('대체식을 확정했습니다. 원재료와 교차접촉 확인 시각을 기록했습니다.')
      await load(overview?.selectedMonth)
    } catch (caught) { setError(caught instanceof Error ? caught.message : '대체식을 확정하지 못했습니다.') }
    finally { setBusyId(undefined) }
  }

  async function cancel(item: SubstitutionItem) {
    setBusyId(item.conflict.id)
    setError('')
    try {
      await substitutionService.cancelConfirmation(item.conflict.id)
      updateDraft(item.conflict.id, { checked: false })
      setMessage('대체식 확정을 취소했습니다.')
      await load(overview?.selectedMonth)
    } catch (caught) { setError(caught instanceof Error ? caught.message : '확정을 취소하지 못했습니다.') }
    finally { setBusyId(undefined) }
  }

  return (
    <main className="page-shell substitution-page">
      <header className="page-header">
        <div><p className="eyebrow">SC-05</p><h1>대체식 추천 및 확정</h1><p>로컬 메뉴와 알레르기 번호를 이용해 후보를 좁힙니다. AI는 안전 여부를 판단하지 않습니다.</p></div>
        <button type="button" onClick={() => void load(overview?.selectedMonth)}>최신 데이터로 갱신</button>
      </header>
      <p className="warning">가공식품은 제품마다 원재료가 다릅니다. 확정 전에 제품 표시와 교차접촉 가능성을 반드시 확인하세요.</p>
      {message && <p className="notice" role="status">{message}</p>}
      {error && <p className="error-panel" role="alert">{error}</p>}

      {overview && overview.state !== 'ready' ? <SubstitutionEmpty state={overview.state} /> : overview && (
        <>
          <section className="conflict-toolbar">
            <label>확정 식단 월<select value={overview.selectedMonth} onChange={(event) => void load(event.target.value as YearMonth)}>{overview.months.map((month) => <option key={month}>{month}</option>)}</select></label>
            <div className="group-buttons"><span>보기 기준</span><button type="button" className={groupMode === 'date' ? 'active' : ''} onClick={() => setGroupMode('date')}>날짜별</button><button type="button" className={groupMode === 'student' ? 'active' : ''} onClick={() => setGroupMode('student')}>학생별</button></div>
          </section>
          {groups.length === 0 ? <section className="empty-state"><h2>대체식 대상 충돌이 없습니다</h2><p>번호상 결과일 뿐 실제 섭취 안전을 보장하지 않습니다.</p></section> : (
            <div className="substitution-groups">{groups.map(([key, items]) => <section className="conflict-group" key={key}><h2>{key} <span>{items.length}</span></h2><div className="substitution-cards">{items.map((item) => <SubstitutionCard key={item.conflict.id} item={item} draft={drafts[item.conflict.id]} busy={busyId === item.conflict.id} updateDraft={updateDraft} confirm={confirm} cancel={cancel} />)}</div></section>)}</div>
          )}
        </>
      )}
    </main>
  )
}

function SubstitutionCard({ item, draft, busy, updateDraft, confirm, cancel }: {
  item: SubstitutionItem
  draft?: Draft
  busy: boolean
  updateDraft: (id: string, change: Partial<Draft>) => void
  confirm: (item: SubstitutionItem) => Promise<void>
  cancel: (item: SubstitutionItem) => Promise<void>
}) {
  const id = item.conflict.id
  const value = draft ?? { directName: '', directAllergens: '', checked: false, mode: 'recommended' as const }
  const confirmed = item.substitution.status === 'confirmed'
  return (
    <article className={item.conflict.kind === 'unknown_menu' ? 'substitution-card blocked-card' : 'substitution-card'}>
      <div className="substitution-heading"><div><span className="status conflict-status">{statusLabel(item.substitution.status)}</span><h3>{item.conflict.menuName}</h3></div><span>{item.student.grade}학년 {item.student.class}반 {item.student.number}번 · {item.student.alias}</span></div>
      <p className="substitution-meta">{item.conflict.date} · {item.conflict.slot} · 학생 알레르기 {allergenLabel(item.studentAllergens)}</p>
      {confirmed && <p className="confirmed-result"><strong>확정 대체식</strong> {item.substitution.substituteName} · 확인 {item.substitution.checkedAt ? new Date(item.substitution.checkedAt).toLocaleString('ko-KR') : '—'}</p>}
      {item.student.needsSubstitute === false ? <p className="blocked-message">대체식 불필요로 등록된 학생입니다. 충돌은 기록하고 제외만 처리합니다.</p> : item.conflict.kind === 'unknown_menu' ? <p className="blocked-message">원래 메뉴의 알레르기 정보가 미확인이라 대체식을 확정할 수 없습니다. SC-04에서 먼저 확인하세요.</p> : (
        <>
          <div className="mode-tabs"><button type="button" className={value.mode === 'recommended' ? 'active' : ''} onClick={() => updateDraft(id, { mode: 'recommended' })}>추천 후보</button><button type="button" className={value.mode === 'manual' ? 'active' : ''} onClick={() => updateDraft(id, { mode: 'manual' })}>직접 입력</button></div>
          {value.mode === 'recommended' ? (
            <div className="candidate-list">
              {item.candidates.length === 0 ? <p className="no-candidate">등록된 메뉴 중 번호 조건을 통과한 후보가 없습니다. 직접 입력을 사용하세요.</p> : <>{item.candidates.map((candidate) => (
                <label key={candidate.key} className={value.candidateKey === candidate.key ? 'selected' : ''}><input type="radio" name={`candidate-${id}`} checked={value.candidateKey === candidate.key} onChange={() => updateDraft(id, { candidateKey: candidate.key })} /><span><strong>{candidate.name}</strong><small>{candidate.allergenStatus === 'none_confirmed' ? '해당 없음 확인됨' : `표기 번호 ${candidate.allergenNos.join(', ')}`} · {candidate.source === 'seed' ? '후보 메뉴 목록' : '이번 달 식단'}{candidate.rememberedCount > 0 ? ` · 이전 선택 ${candidate.rememberedCount}회` : ''}</small></span></label>
              ))}{item.candidates.length < 5 && <p className="candidate-shortage">조건에 맞는 후보 {item.candidates.length}개만 찾았습니다.</p>}</>}
            </div>
          ) : (
            <div className="direct-substitute"><label>대체 메뉴명<input value={value.directName} onChange={(event) => updateDraft(id, { directName: event.target.value })} /></label><label>알레르기 번호<input placeholder="예: 1.5 또는 없음" value={value.directAllergens} onChange={(event) => updateDraft(id, { directAllergens: event.target.value })} /></label></div>
          )}
          <label className="processed-check"><input type="checkbox" checked={value.checked} onChange={(event) => updateDraft(id, { checked: event.target.checked })} /> 가공품 원재료와 교차접촉 가능성을 확인했습니다.</label>
          <div className="substitution-actions">{confirmed && <button type="button" disabled={busy} onClick={() => void cancel(item)}>확정 취소</button>}<button type="button" className="primary" disabled={busy || !value.checked} onClick={() => void confirm(item)}>{confirmed ? '선택 내용으로 재확정' : '대체식 확정'}</button></div>
        </>
      )}
    </article>
  )
}

function allergenLabel(numbers: AllergenNo[]): string {
  return numbers.map((number) => `${number}.${ALLERGEN_ITEMS.find((item) => item.no === number)?.name ?? ''}`).join(', ')
}

function statusLabel(status: SubstitutionItem['substitution']['status']): string {
  return { pending: '미확정', confirmed: '확정', excludeOnly: '제외만', needs_review: '재검토 필요', obsolete: '더 이상 해당 없음' }[status]
}

function SubstitutionEmpty({ state }: { state: SubstitutionOverview['state'] }) {
  const content = {
    no_meal_plan: ['저장된 식단이 없습니다', 'SC-04에서 식단을 불러와 주세요.'],
    not_confirmed: ['확정된 식단이 없습니다', 'SC-04에서 식단을 확정해 주세요.'],
    no_students: ['등록된 학생이 없습니다', 'SC-03에서 학생 알레르기를 등록해 주세요.'],
    ready: ['', ''],
  }[state]
  return <section className="empty-state"><h2>{content[0]}</h2><p>{content[1]}</p></section>
}
