import { useEffect, useMemo, useState } from 'react'
import mealIcon from '../../assets/figma/icon-meal.svg'
import mealIconSelected from '../../assets/figma/icon-meal-selected.svg'
import searchIcon from '../../assets/figma/icon-search.svg'
import type { AllergenNo, YearMonth } from '../../data'
import { navigate } from '../../app/navigation'
import { Button, Notice, PageHeader, SectionTitle } from '../../ui'
import { parseAllergenValue } from '../meal-plan/mealPlanParser'
import { ALLERGEN_ITEMS } from '../students/allergens'
import { EvidencePanel } from './EvidencePanel'
import type { CandidateMenu } from './substitutionRecommendation'
import { substitutionService, type SubstitutionItem, type SubstitutionOverview, type SubstitutionSelection } from './substitutionService'

/** SC-05 대체식 관리 (Figma Frame 39). 추천·확정·확정 취소는 기존 substitutionService, 근거 검색은 EvidencePanel을 쓴다. */
export function SubstitutionPage() {
  const [overview, setOverview] = useState<SubstitutionOverview>()
  const [selectedId, setSelectedId] = useState<string>()
  const [candidateKey, setCandidateKey] = useState<string>()
  const [direct, setDirect] = useState('')
  const [checked, setChecked] = useState(false)
  const [showEvidence, setShowEvidence] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function load(yearMonth?: YearMonth, keepSelection = selectedId) {
    setError('')
    try {
      const next = await substitutionService.load(yearMonth)
      setOverview(next)
      const items = sortItems(next.items)
      const keep = items.find((item) => item.conflict.id === keepSelection)
      select(keep ?? items.find((item) => needsAction(item)) ?? items[0])
    } catch (caught) { setError(caught instanceof Error ? caught.message : '대체식 정보를 불러오지 못했습니다.') }
  }
  // IndexedDB는 외부 저장소이므로 화면을 열 때 한 번 불러온다.
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void load() }, [])

  function select(item?: SubstitutionItem) {
    setSelectedId(item?.conflict.id)
    const remembered = item?.candidates.find((candidate) => candidate.name === item.substitution.substituteName)
    setCandidateKey(item?.substitution.selectionSource === 'recommended' ? remembered?.key : undefined)
    setDirect(item?.substitution.selectionSource === 'manual' ? `${item.substitution.substituteName ?? ''} ${item.substitution.substituteAllergenStatus === 'none_confirmed' ? '없음' : item.substitution.substituteAllergenNos?.join('.') ?? ''}`.trim() : '')
    setChecked(false)
    setShowEvidence(false)
  }

  const items = useMemo(() => sortItems(overview?.items ?? []), [overview])
  const selected = items.find((item) => item.conflict.id === selectedId)
  const unknownCount = items.filter((item) => item.conflict.kind === 'unknown_menu').length
  const groupMates = selected ? items.filter((item) => item.conflict.id !== selected.conflict.id && sameCombination(item, selected) && needsAction(item)) : []
  const chosen = selected?.candidates.find((candidate) => candidate.key === candidateKey)

  function buildSelection(): SubstitutionSelection {
    if (chosen) return { name: chosen.name, allergenStatus: chosen.allergenStatus, allergenNos: chosen.allergenNos, source: 'recommended' }
    const value = direct.trim()
    const split = value.lastIndexOf(' ')
    if (!value || split < 0) throw new Error('후보를 고르거나, 직접 입력에 “메뉴명 번호” 형식으로 입력해 주세요. 예) 두부조림 5 또는 두부조림 없음')
    const name = value.slice(0, split).replace(/[·\s]+$/, '').trim()
    const parsed = parseAllergenValue(value.slice(split + 1))
    if (!name || parsed.error || parsed.status === 'unknown') throw new Error(parsed.error ?? '직접 입력 메뉴의 알레르기 번호 또는 ‘없음’을 입력해 주세요.')
    return { name, allergenStatus: parsed.status, allergenNos: parsed.allergenNos, source: 'manual' }
  }

  async function confirm(targets: SubstitutionItem[]) {
    if (!selected) return
    setBusy(true); setError(''); setMessage('')
    try {
      const selection = buildSelection()
      for (const target of targets) await substitutionService.confirm(target.conflict.id, selection, checked)
      setMessage(targets.length > 1 ? `같은 조합 학생 ${targets.length}명의 대체식을 확정했습니다. 원재료·교차오염 확인 시각을 기록했습니다.` : '대체식을 확정했습니다. 원재료·교차오염 확인 시각을 기록했습니다.')
      await load(overview?.selectedMonth, selected.conflict.id)
    } catch (caught) { setError(caught instanceof Error ? caught.message : '대체식을 확정하지 못했습니다.'); await load(overview?.selectedMonth, selected.conflict.id) }
    finally { setBusy(false) }
  }

  async function cancel() {
    if (!selected) return
    setBusy(true); setError('')
    try {
      await substitutionService.cancelConfirmation(selected.conflict.id)
      setMessage('대체식 확정을 취소했습니다.')
      await load(overview?.selectedMonth, selected.conflict.id)
    } catch (caught) { setError(caught instanceof Error ? caught.message : '확정을 취소하지 못했습니다.') }
    finally { setBusy(false) }
  }

  const confirmable = selected && selected.conflict.kind === 'allergen' && selected.student.needsSubstitute !== false
  const ready = Boolean(confirmable && checked && (chosen || direct.trim()))

  return <div className="page stack stack--lg">
    <PageHeader title="대체식 관리" actions={<>
      {overview && overview.months.length > 1 && <select className="ds-input" style={{ width: 'auto' }} aria-label="확정 식단 월" value={overview.selectedMonth} onChange={(event) => void load(event.target.value as YearMonth)}>{overview.months.map((month) => <option key={month}>{month}</option>)}</select>}
      <Button size="lg" onClick={() => navigate('conflicts')}>충돌 탐지 상세</Button>
      <Button size="lg" variant="primary" onClick={() => navigate('documents')}>문서 만들기</Button>
    </>} />

    <div className="stack" style={{ gap: 12, marginTop: -40 }}>
      <Notice tone="warning" role="note">가공식품은 제품마다 원재료가 다릅니다. 확정 전에 제품 표시와 교차오염 가능성을 확인하세요.</Notice>
      {unknownCount > 0 && <Notice tone="danger">미확인 메뉴 {unknownCount}건 — 알레르기 탐지 결과가 불완전합니다. 해당 날짜의 알레르기 학생은 ‘확인 필요’로 묶였습니다.</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>

    {overview && overview.state !== 'ready' ? <EmptyState state={overview.state} /> : overview && (items.length === 0
      ? <div className="empty"><strong>대체식 대상 충돌이 없습니다</strong>번호상 결과일 뿐 실제 섭취 안전을 보장하지 않습니다.</div>
      : <>
        <section className="stack" style={{ gap: 16 }}>
          <SectionTitle>충돌 목록 <span className="subtle" style={{ fontSize: 16, fontWeight: 400 }}>{overview.selectedMonth} · {items.length}건</span></SectionTitle>
          <div className="conflict-strip" role="tablist" aria-label="충돌 목록">
            {items.map((item) => <button key={item.conflict.id} type="button" role="tab" aria-selected={item.conflict.id === selectedId} className={`conflict-tab${item.conflict.id === selectedId ? ' is-active' : ''}`} onClick={() => select(item)}>
              <span className={`conflict-tab__status${needsAction(item) ? ' is-danger' : ''}`}>{item.conflict.date.slice(5).replace('-', '/')}  ·  {statusLabel(item)}</span>
              <strong>{item.student.grade}-{item.student.class}-{item.student.number} {item.student.alias}</strong>
              <span>못 먹는 메뉴  {item.conflict.menuName}</span>
              <small>{item.conflict.kind === 'unknown_menu' ? '메뉴 알레르기 정보 미확인' : `알레르기 번호 ${item.conflict.allergenNos.join(', ')}`}</small>
            </button>)}
          </div>
        </section>

        {selected && <section className="stack" style={{ gap: 16 }}>
          <SectionTitle>대체 후보 · {selected.conflict.date.slice(5).replace('-', '/')} {selected.conflict.menuName} {selected.conflict.allergenNos.length > 0 && `(번호 ${selected.conflict.allergenNos.join(', ')})`}</SectionTitle>
          <p className="subtle">학생 알레르기 {allergenLabel(selected.studentAllergens)} · 학생 번호와 겹치거나 미확인인 메뉴는 후보에서 제외됩니다.</p>
          {selected.substitution.status === 'confirmed' && <Notice tone="success">확정 대체식: <strong>{selected.substitution.substituteName}</strong> · 확인 {selected.substitution.checkedAt ? new Date(selected.substitution.checkedAt).toLocaleString('ko-KR') : '—'}</Notice>}
          {selected.substitution.status === 'needs_review' && <Notice tone="warning">식단 또는 학생 정보가 바뀌어 재검토가 필요합니다. 내용을 확인하고 다시 체크·확정해 주세요.</Notice>}
          {selected.student.needsSubstitute === false ? <Notice>대체식 불필요로 등록된 학생입니다. 충돌은 기록하고 ‘제외만’으로 처리합니다.</Notice>
            : selected.conflict.kind === 'unknown_menu' ? <div className="row row--between ds-notice ds-notice--warning"><span>원래 메뉴의 알레르기 정보가 미확인이라 대체식을 확정할 수 없습니다.</span><Button onClick={() => navigate('meals')}>메뉴 확인하러 가기</Button></div>
              : <>
                {selected.candidates.length === 0 ? <div className="empty"><strong>등록된 메뉴 중 후보 없음</strong>아래 ‘직접 입력’에 메뉴명과 알레르기 번호를 입력해 주세요.</div>
                  : <div className="candidate-strip" role="radiogroup" aria-label="대체 후보">
                    {selected.candidates.map((candidate) => <CandidateCard key={candidate.key} candidate={candidate} original={selected} selected={candidate.key === candidateKey}
                      onSelect={() => { setCandidateKey(candidate.key === candidateKey ? undefined : candidate.key); setDirect(''); setShowEvidence(false) }} />)}
                  </div>}
                {selected.candidates.length > 0 && selected.candidates.length < 5 && <p className="subtle">조건에 맞는 후보 {selected.candidates.length}개만 찾았습니다.</p>}

                <div className="subst-actions">
                  <div className="subst-inputs">
                    <label className="ds-field" style={{ width: 360 }}>
                      <span className="ds-field__label">직접 입력</span>
                      <span className="input-icon"><input value={direct} placeholder="메뉴명 · 알레르기 번호 (예: 두부조림 5)" onChange={(event) => { setDirect(event.target.value); if (event.target.value) setCandidateKey(undefined) }} /><img src={searchIcon} alt="" width={20} height={20} /></span>
                    </label>
                    <div className="ds-field" style={{ width: 360 }}>
                      <span className="ds-field__label">선택 근거 확인</span>
                      <button type="button" className="ds-input input-icon" style={{ textAlign: 'left', color: 'var(--c-ink-subtle)', fontSize: 16 }} disabled={!chosen} onClick={() => setShowEvidence((value) => !value)}>
                        {chosen ? `근거 찾기 · ${chosen.name}` : '근거 찾기 (후보를 먼저 선택)'}<img src={searchIcon} alt="" width={20} height={20} />
                      </button>
                    </div>
                  </div>
                  {showEvidence && chosen && <div style={{ width: '100%' }}><EvidencePanel key={chosen.key} candidateName={chosen.name} allergenOptions={selected.original.allergenNos} /></div>}
                  <label className="check processed-check"><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} /> 가공품 원재료와 교차오염 가능성을 확인했습니다.</label>
                  <div className="subst-confirm">
                    {selected.substitution.status === 'confirmed' && <Button disabled={busy} onClick={() => void cancel()}>확정 취소</Button>}
                    <Button disabled={!ready || busy || groupMates.length === 0} title={groupMates.length ? `${groupMates.map((item) => item.student.alias).join(', ')}` : '같은 날·같은 메뉴·같은 알레르기 조합의 미확정 학생이 없습니다'} onClick={() => void confirm([selected, ...groupMates])}>같은 조합 학생 함께 확정{groupMates.length ? ` (${groupMates.length + 1}명)` : ''}</Button>
                    <Button variant={ready ? 'primary' : 'muted'} disabled={!ready || busy} onClick={() => void confirm([selected])}>{selected.substitution.status === 'confirmed' ? '재확정' : '확정'}</Button>
                  </div>
                </div>
              </>}
        </section>}
      </>)}
  </div>
}

function CandidateCard({ candidate, original, selected, onSelect }: { candidate: CandidateMenu; original: SubstitutionItem; selected: boolean; onSelect: () => void }) {
  const energy = diff(candidate.energy, original.original.energy)
  const protein = diff(candidate.protein, original.original.protein)
  return <button type="button" role="radio" aria-checked={selected} className={`candidate-card${selected ? ' is-selected' : ''}`} onClick={onSelect}>
    <span className={`candidate-card__head${candidate.rememberedCount > 0 ? ' is-remembered' : ''}`}>
      <img src={selected ? mealIconSelected : mealIcon} alt="" width={40} height={40} />
      {candidate.rememberedCount > 0 ? `지난번 선택 (${candidate.rememberedCount}회)` : candidate.source === 'seed' ? '대체 후보 · 후보 메뉴 목록' : '대체 후보 · 이번 달 식단'}
    </span>
    <span className="candidate-card__name">{candidate.name}</span>
    <span className="candidate-card__nos">{candidate.allergenStatus === 'none_confirmed' ? '알레르기 번호  없음' : `알레르기 번호  ${candidate.allergenNos.join(', ')}`}</span>
    <span className="candidate-card__diff">
      <div><span>에너지 차</span><strong>{energy === undefined ? '—' : `${energy > 0 ? '+' : ''}${Math.round(energy)}kcal`}</strong></div>
      <div><span>단백질 차</span><strong>{protein === undefined ? '—' : `${protein > 0 ? '+' : ''}${protein.toFixed(1)}g`}</strong></div>
    </span>
  </button>
}

function diff(value?: number, base?: number) { return value === undefined || base === undefined ? undefined : value - base }

function needsAction(item: SubstitutionItem) {
  return item.conflict.kind === 'unknown_menu' || item.substitution.status === 'pending' || item.substitution.status === 'needs_review'
}

function sameCombination(a: SubstitutionItem, b: SubstitutionItem) {
  return a.conflict.kind === 'allergen' && b.conflict.kind === 'allergen' && a.conflict.date === b.conflict.date && a.conflict.menuName === b.conflict.menuName
    && a.student.needsSubstitute !== false && [...a.studentAllergens].sort().join(',') === [...b.studentAllergens].sort().join(',')
}

function sortItems(items: SubstitutionItem[]) {
  return [...items].sort((a, b) => a.conflict.date.localeCompare(b.conflict.date) || a.student.grade - b.student.grade || a.student.class - b.student.class || a.student.number - b.student.number)
}

function statusLabel(item: SubstitutionItem): string {
  if (item.conflict.kind === 'unknown_menu') return '확인 필요'
  return { pending: '미확정', confirmed: '확정', excludeOnly: '제외만', needs_review: '재검토 필요', obsolete: '해당 없음' }[item.substitution.status]
}

function allergenLabel(numbers: AllergenNo[]): string {
  return numbers.map((number) => `${number}.${ALLERGEN_ITEMS.find((item) => item.no === number)?.name ?? ''}`).join(', ')
}

function EmptyState({ state }: { state: SubstitutionOverview['state'] }) {
  const [title, body, target] = {
    no_meal_plan: ['저장된 식단이 없습니다', '식단 불러오기에서 엑셀을 올려 주세요.', 'meals'],
    not_confirmed: ['확정된 식단이 없습니다', '식단을 확정하기 전에는 대체식이 잠겨 있습니다.', 'meals'],
    no_students: ['등록된 학생이 없습니다', '학생 알레르기에서 학생을 등록해 주세요.', 'students'],
    ready: ['', '', 'home'],
  }[state] as [string, string, 'meals' | 'students' | 'home']
  return <div className="empty"><strong>{title}</strong>{body}<div style={{ marginTop: 16 }}><Button onClick={() => navigate(target)}>바로 가기</Button></div></div>
}
