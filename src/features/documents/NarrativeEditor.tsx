import { useEffect, useState, type ReactNode } from 'react'
import { RELAY_NUTRITION_TOPICS, relayClient, type RelayNutritionTopicId } from '../relay/relayClient'
import type { GeneratedDoc, ReviewChecklist, TextDraft } from '../../data'
import type { NarrativeKey, NarrativeSlot, S2Document, S5Document } from './documentModels'
import {
  NARRATIVE_KEYS, NUTRITION_TOPIC_LABELS, S5_NARRATIVE_KEY, describeNarrativeError, isAiSource, narrativeService,
} from './narrative'
import { anonymizeS5Counts } from './s5Anonymize'

const SOURCE_LABEL: Record<TextDraft['source'], string> = { router: 'Router 초안', liner: 'Liner 초안', manual: '직접 입력', template: '기본 문구' }
const CHECKS: { key: keyof ReviewChecklist; label: string }[] = [
  { key: 'sourceChecked', label: '출처 확인' }, { key: 'noMedicalClaim', label: '질병 치료·효능 단정 없음' }, { key: 'factsChecked', label: '숫자·메뉴명 확인' },
]

type Drafts = Partial<Record<NarrativeKey, TextDraft>>

/** 문구 칸 상태(초안·텍스트·메시지)를 불러오고 갱신하는 공통 훅. */
function useNarrativeState(doc: GeneratedDoc, onChanged: () => Promise<void> | void) {
  const [drafts, setDrafts] = useState<Drafts>({})
  const [texts, setTexts] = useState<Partial<Record<NarrativeKey, string>>>({})
  const [busy, setBusy] = useState<NarrativeKey>()
  const [messages, setMessages] = useState<Partial<Record<NarrativeKey, string>>>({})

  useEffect(() => {
    let active = true
    void narrativeService.getDrafts(doc.id).then((loaded) => {
      if (!active) return
      setDrafts(loaded)
      setTexts(Object.fromEntries(Object.entries(loaded).map(([key, draft]) => [key, draft?.text ?? ''])))
    })
    return () => { active = false }
  }, [doc.id, doc.updatedAt])

  async function run(key: NarrativeKey, action: () => Promise<unknown>, success?: string) {
    setBusy(key); setMessages((current) => ({ ...current, [key]: '' }))
    try { await action(); await onChanged(); if (success) setMessages((current) => ({ ...current, [key]: success })) }
    catch (error) { setMessages((current) => ({ ...current, [key]: describeNarrativeError(error) })) }
    finally { setBusy(undefined) }
  }
  return { drafts, texts, setTexts, busy, messages, run }
}

type State = ReturnType<typeof useNarrativeState>

/** S2 문구 칸 임시 UI. AI 응답은 초안으로만 표시하고 검토·승인 전에는 문서에 반영하지 않는다. */
export function S2NarrativeEditor({ doc, onChanged }: { doc: GeneratedDoc; onChanged: () => Promise<void> | void }) {
  const state = useNarrativeState(doc, onChanged)
  const [menus, setMenus] = useState<{ all: string[]; selected: string[] }>({ all: [], selected: [] })
  const [topic, setTopic] = useState<RelayNutritionTopicId>(RELAY_NUTRITION_TOPICS[0])
  const editable = doc.status === 'draft'
  const artifact = doc.content as S2Document

  useEffect(() => {
    if (!editable) return
    let active = true
    void narrativeService.listMenuCandidates(doc.id).catch(() => ({ all: [] as string[], suggested: [] as string[] })).then((candidates) => {
      if (!active) return
      setMenus((current) => ({ all: candidates.all, selected: current.selected.length > 0 ? current.selected.filter((name) => candidates.all.includes(name)) : candidates.suggested }))
    })
    return () => { active = false }
  }, [doc.id, doc.updatedAt, editable])

  function toggleMenu(name: string) {
    setMenus((current) => ({
      ...current,
      selected: current.selected.includes(name) ? current.selected.filter((item) => item !== name) : current.selected.length >= 3 ? current.selected : [...current.selected, name],
    }))
  }

  return <section className="narrative-editor no-print">
    <h3>S2 문구 작성·검토</h3>
    <p className="safety-notice">Relay에는 월·대표 메뉴명·영양 교육 주제 ID만 전송됩니다. 학생 정보는 전송되지 않으며, 개인정보로 의심되는 값은 요청 전에 차단됩니다. AI 문구는 자동 승인되지 않습니다.</p>
    <ConnectionNotice editable={editable} />
    {NARRATIVE_KEYS.map((key) => {
      const slot = artifact.narrativeSlots.find((item) => item.key === key)
      const controls = key === 'monthlyNews'
        ? <>
          <fieldset><legend>대표 메뉴 (최대 3개, 확정 식단의 메뉴명)</legend>{menus.all.map((name) => <label key={name}><input type="checkbox" checked={menus.selected.includes(name)} onChange={() => toggleMenu(name)} /> {name}</label>)}</fieldset>
          <button disabled={state.busy !== undefined || menus.selected.length === 0} onClick={() => void state.run(key, () => narrativeService.generateNews(doc.id, menus.selected), AI_DONE)}>{state.busy === key ? '처리 중…' : 'AI 문구 생성'}</button>
        </>
        : <>
          <label>영양 교육 주제<select value={topic} onChange={(event) => setTopic(event.target.value as RelayNutritionTopicId)}>{RELAY_NUTRITION_TOPICS.map((id) => <option key={id} value={id}>{NUTRITION_TOPIC_LABELS[id]}</option>)}</select></label>
          <button disabled={state.busy !== undefined} onClick={() => void state.run(key, () => narrativeService.generateNutrition(doc.id, topic), AI_DONE)}>{state.busy === key ? '처리 중…' : 'AI 문구 생성'}</button>
        </>
      return <NarrativeCard key={key} doc={doc} narrativeKey={key} slot={slot} state={state} editable={editable} controls={controls} />
    })}
  </section>
}

/** S5 보고 본문 임시 UI. 외부로는 0~2명을 "3명 미만"으로 바꾼 집계만 전송하고, 보고서 표는 정확한 로컬 통계를 쓴다. */
export function S5NarrativeEditor({ doc, onChanged }: { doc: GeneratedDoc; onChanged: () => Promise<void> | void }) {
  const state = useNarrativeState(doc, onChanged)
  const editable = doc.status === 'draft'
  const artifact = doc.content as S5Document
  const slot = artifact.narrativeSlots?.find((item) => item.key === S5_NARRATIVE_KEY)
  if (!slot) return <section className="narrative-editor no-print"><p className="warning">이전 형식으로 저장된 S5입니다. AI 본문을 쓰려면 연간 운영 보고서를 다시 생성해 주세요.</p></section>
  const outbound = anonymizeS5Counts(artifact)
  const controls = <>
    <button disabled={state.busy !== undefined} onClick={() => void state.run(S5_NARRATIVE_KEY, () => narrativeService.generateS5Body(doc.id), AI_DONE)}>{state.busy === S5_NARRATIVE_KEY ? '처리 중…' : 'AI 본문 생성'}</button>
    <details><summary>외부로 전송되는 비식별 집계 보기 (로컬 표는 정확한 값을 유지합니다)</summary>
      <pre className="outbound-preview">{JSON.stringify(outbound.counts, null, 1)}</pre></details>
  </>
  return <section className="narrative-editor no-print">
    <h3>S5 보고 본문 작성·검토</h3>
    <p className="safety-notice">Relay에는 알레르기 번호별·학년별 인원과 제공·제외 건수만 전송되며, 3명 미만(0~2명)은 "3명 미만"으로 바뀝니다. 학생 정보와 합계는 전송되지 않습니다. 비식별 집계도 통계적 익명성을 보증하지 않습니다. AI 본문은 자동 승인되지 않습니다.</p>
    <ConnectionNotice editable={editable} />
    <NarrativeCard doc={doc} narrativeKey={S5_NARRATIVE_KEY} slot={slot} state={state} editable={editable} controls={controls} />
  </section>
}

const AI_DONE = 'AI 초안을 받았습니다. 검토 후 승인해 주세요.'

function ConnectionNotice({ editable }: { editable: boolean }) {
  return <>
    {!relayClient.hasToken() && <p className="warning">Relay에 연결되어 있지 않습니다. 직접 입력하거나 기본 문구를 사용할 수 있습니다.</p>}
    {!editable && <p className="notice">승인·재검토 상태의 문서는 문구를 수정할 수 없습니다. 수정하려면 문서를 다시 생성해 주세요.</p>}
  </>
}

function NarrativeCard({ doc, narrativeKey: key, slot, state, editable, controls }: {
  doc: GeneratedDoc; narrativeKey: NarrativeKey; slot?: NarrativeSlot; state: State; editable: boolean; controls: ReactNode
}) {
  const { drafts, texts, setTexts, busy, messages, run } = state
  const draft = drafts[key]
  const text = texts[key] ?? ''
  const dirty = text.trim() !== (draft?.text ?? '')
  const ai = draft ? isAiSource(draft.source) : false
  const allChecked = draft ? CHECKS.every((check) => draft.reviewChecklist[check.key]) : false
  return <article className="narrative-card">
    <h4>{slot?.label} <span className={`doc-status ${slot?.state === 'approved' ? 'approved' : 'draft'}`}>{slot?.state === 'approved' ? '승인됨' : slot?.state === 'draft' ? '검토 중' : '미작성'}</span></h4>
    {draft && <AiStatus draft={draft} />}
    {editable && <div className="narrative-controls">
      {controls}
      <button disabled={busy !== undefined} onClick={() => void run(key, () => narrativeService.useTemplate(doc.id, key), '기본 문구를 넣었습니다. 내용을 확인하고 승인해 주세요.')}>기본 문구 사용</button>
    </div>}
    <textarea rows={4} value={text} disabled={!editable} onChange={(event) => setTexts((current) => ({ ...current, [key]: event.target.value }))} placeholder="AI 생성, 기본 문구 또는 직접 입력" />
    {draft && draft.citations.length > 0 && <ul className="citations">{draft.citations.map((citation) => <li key={citation.url}><a href={citation.url} target="_blank" rel="noopener noreferrer">{citation.title || citation.url}</a></li>)}</ul>}
    {editable && <div className="narrative-controls">
      <button disabled={busy !== undefined || !text.trim() || !dirty} onClick={() => void run(key, () => narrativeService.saveText(doc.id, key, text), '문구를 저장했습니다. 검토 항목을 다시 확인해 주세요.')}>수정 내용 저장</button>
    </div>}
    {editable && draft && ai && <fieldset><legend>검토 항목 (AI 문구는 모두 확인해야 승인할 수 있습니다)</legend>
      {CHECKS.map((check) => <label key={check.key}><input type="checkbox" checked={draft.reviewChecklist[check.key]} disabled={busy !== undefined || dirty}
        onChange={(event) => void run(key, () => narrativeService.setChecklist(doc.id, key, { ...draft.reviewChecklist, [check.key]: event.target.checked }))} /> {check.label}</label>)}
    </fieldset>}
    {editable && draft && <button className="primary" disabled={busy !== undefined || dirty || draft.approved || (ai && !allChecked)}
      onClick={() => void run(key, () => narrativeService.approveText(doc.id, key), '문구를 승인했습니다.')}>{draft.approved ? '승인됨' : '이 문구 승인'}</button>}
    {messages[key] && <p className="warning" role="status">{messages[key]}</p>}
  </article>
}

/** 응답 상태 표시: 모의 결과, 출처 없음, 검토 필수, 캐시 여부. */
export function AiStatus({ draft }: { draft: Pick<TextDraft, 'source' | 'edited' | 'meta'> }) {
  return <p className="status-label">
    {SOURCE_LABEL[draft.source]}{draft.edited ? ' · 수정됨' : ''}
    {draft.meta?.simulated && <strong className="badge-simulated"> · 모의(simulated) 결과 — 실제 AI 응답이 아닙니다</strong>}
    {draft.meta?.sourceMissing && <strong className="badge-warning"> · 출처 없음(sourceMissing)</strong>}
    {draft.meta?.reviewRequired && <strong> · 검토 필수</strong>}
    {draft.meta?.cached && ' · 캐시된 응답'}
  </p>
}
