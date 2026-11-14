import { useEffect, useState } from 'react'
import { RELAY_NUTRITION_TOPICS, relayClient, type RelayNutritionTopicId } from '../relay/relayClient'
import type { GeneratedDoc, ReviewChecklist, TextDraft } from '../../data'
import type { S2Document } from './documentModels'
import {
  NARRATIVE_KEYS, NUTRITION_TOPIC_LABELS, describeNarrativeError, isAiSource, s2NarrativeService, type NarrativeKey,
} from './s2Narrative'

const SOURCE_LABEL: Record<TextDraft['source'], string> = { router: 'Router 초안', liner: 'Liner 초안', manual: '직접 입력', template: '기본 문구' }
const CHECKS: { key: keyof ReviewChecklist; label: string }[] = [
  { key: 'sourceChecked', label: '출처 확인' }, { key: 'noMedicalClaim', label: '질병 치료·효능 단정 없음' }, { key: 'factsChecked', label: '숫자·메뉴명 확인' },
]

/** S2 문구 칸 임시 UI. AI 응답은 초안으로만 표시하고 검토·승인 전에는 문서에 반영하지 않는다. */
export function S2NarrativeEditor({ doc, onChanged }: { doc: GeneratedDoc; onChanged: () => Promise<void> | void }) {
  const [drafts, setDrafts] = useState<Partial<Record<NarrativeKey, TextDraft>>>({})
  const [texts, setTexts] = useState<Partial<Record<NarrativeKey, string>>>({})
  const [menus, setMenus] = useState<{ all: string[]; selected: string[] }>({ all: [], selected: [] })
  const [topic, setTopic] = useState<RelayNutritionTopicId>(RELAY_NUTRITION_TOPICS[0])
  const [busy, setBusy] = useState<NarrativeKey>()
  const [messages, setMessages] = useState<Partial<Record<NarrativeKey, string>>>({})
  const editable = doc.status === 'draft'
  const artifact = doc.content as S2Document

  useEffect(() => {
    let active = true
    void (async () => {
      const loaded = await s2NarrativeService.getDrafts(doc.id)
      const candidates = editable ? await s2NarrativeService.listMenuCandidates(doc.id).catch(() => ({ all: [] as string[], suggested: [] as string[] })) : { all: [], suggested: [] }
      if (!active) return
      setDrafts(loaded)
      setTexts({ monthlyNews: loaded.monthlyNews?.text ?? '', nutritionEducation: loaded.nutritionEducation?.text ?? '' })
      setMenus((current) => ({ all: candidates.all, selected: current.selected.length > 0 ? current.selected.filter((name) => candidates.all.includes(name)) : candidates.suggested }))
    })()
    return () => { active = false }
  }, [doc.id, doc.updatedAt, editable])

  async function run(key: NarrativeKey, action: () => Promise<unknown>, success?: string) {
    setBusy(key); setMessages((current) => ({ ...current, [key]: '' }))
    try { await action(); await onChanged(); if (success) setMessages((current) => ({ ...current, [key]: success })) }
    catch (error) { setMessages((current) => ({ ...current, [key]: describeNarrativeError(error) })) }
    finally { setBusy(undefined) }
  }

  function toggleMenu(name: string) {
    setMenus((current) => ({
      ...current,
      selected: current.selected.includes(name) ? current.selected.filter((item) => item !== name) : current.selected.length >= 3 ? current.selected : [...current.selected, name],
    }))
  }

  return <section className="narrative-editor no-print">
    <h3>S2 문구 작성·검토</h3>
    <p className="safety-notice">Relay에는 월·대표 메뉴명·영양 교육 주제 ID만 전송됩니다. 학생 정보는 전송되지 않으며, 개인정보로 의심되는 값은 요청 전에 차단됩니다. AI 문구는 자동 승인되지 않습니다.</p>
    {!relayClient.hasToken() && <p className="warning">Relay에 연결되어 있지 않습니다. 직접 입력하거나 기본 문구를 사용할 수 있습니다.</p>}
    {!editable && <p className="notice">승인·재검토 상태의 S2는 문구를 수정할 수 없습니다. 수정하려면 문서를 다시 생성해 주세요.</p>}
    {NARRATIVE_KEYS.map((key) => {
      const slot = artifact.narrativeSlots.find((item) => item.key === key)
      const draft = drafts[key]
      const text = texts[key] ?? ''
      const dirty = text.trim() !== (draft?.text ?? '')
      const ai = draft ? isAiSource(draft.source) : false
      const allChecked = draft ? CHECKS.every((check) => draft.reviewChecklist[check.key]) : false
      return <article key={key} className="narrative-card">
        <h4>{slot?.label} <span className={`doc-status ${slot?.state === 'approved' ? 'approved' : 'draft'}`}>{slot?.state === 'approved' ? '승인됨' : slot?.state === 'draft' ? '검토 중' : '미작성'}</span></h4>
        {draft && <p className="status-label">
          {SOURCE_LABEL[draft.source]}{draft.edited ? ' · 수정됨' : ''}
          {draft.meta?.simulated && <strong className="badge-simulated"> · 모의(simulated) 결과 — 실제 AI 응답이 아닙니다</strong>}
          {draft.meta?.sourceMissing && <strong className="badge-warning"> · 출처 없음(sourceMissing)</strong>}
          {draft.meta?.reviewRequired && <strong> · 검토 필수</strong>}
          {draft.meta?.cached && ' · 캐시된 응답'}
        </p>}
        {editable && <div className="narrative-controls">
          {key === 'monthlyNews'
            ? <fieldset><legend>대표 메뉴 (최대 3개, 확정 식단의 메뉴명)</legend>{menus.all.map((name) => <label key={name}><input type="checkbox" checked={menus.selected.includes(name)} onChange={() => toggleMenu(name)} /> {name}</label>)}</fieldset>
            : <label>영양 교육 주제<select value={topic} onChange={(event) => setTopic(event.target.value as RelayNutritionTopicId)}>{RELAY_NUTRITION_TOPICS.map((id) => <option key={id} value={id}>{NUTRITION_TOPIC_LABELS[id]}</option>)}</select></label>}
          <button disabled={busy !== undefined || (key === 'monthlyNews' && menus.selected.length === 0)}
            onClick={() => void run(key, () => key === 'monthlyNews' ? s2NarrativeService.generateNews(doc.id, menus.selected) : s2NarrativeService.generateNutrition(doc.id, topic), 'AI 초안을 받았습니다. 검토 후 승인해 주세요.')}>
            {busy === key ? '처리 중…' : 'AI 문구 생성'}</button>
          <button disabled={busy !== undefined} onClick={() => void run(key, () => s2NarrativeService.useTemplate(doc.id, key), '기본 문구를 넣었습니다. 내용을 확인하고 승인해 주세요.')}>기본 문구 사용</button>
        </div>}
        <textarea rows={4} value={text} disabled={!editable} onChange={(event) => setTexts((current) => ({ ...current, [key]: event.target.value }))} placeholder="AI 생성, 기본 문구 또는 직접 입력" />
        {draft && draft.citations.length > 0 && <ul className="citations">{draft.citations.map((citation) => <li key={citation.url}><a href={citation.url} target="_blank" rel="noopener noreferrer">{citation.title || citation.url}</a></li>)}</ul>}
        {editable && <div className="narrative-controls">
          <button disabled={busy !== undefined || !text.trim() || !dirty} onClick={() => void run(key, () => s2NarrativeService.saveText(doc.id, key, text), '문구를 저장했습니다. 검토 항목을 다시 확인해 주세요.')}>수정 내용 저장</button>
        </div>}
        {editable && draft && ai && <fieldset><legend>검토 항목 (AI 문구는 모두 확인해야 승인할 수 있습니다)</legend>
          {CHECKS.map((check) => <label key={check.key}><input type="checkbox" checked={draft.reviewChecklist[check.key]} disabled={busy !== undefined || dirty}
            onChange={(event) => void run(key, () => s2NarrativeService.setChecklist(doc.id, key, { ...draft.reviewChecklist, [check.key]: event.target.checked }))} /> {check.label}</label>)}
        </fieldset>}
        {editable && draft && <button className="primary" disabled={busy !== undefined || dirty || draft.approved || (ai && !allChecked)}
          onClick={() => void run(key, () => s2NarrativeService.approveText(doc.id, key), '문구를 승인했습니다.')}>{draft.approved ? '승인됨' : '이 문구 승인'}</button>}
        {messages[key] && <p className="warning" role="status">{messages[key]}</p>}
      </article>
    })}
  </section>
}
