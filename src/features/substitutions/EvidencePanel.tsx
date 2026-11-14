import { useEffect, useState } from 'react'
import type { AllergenNo } from '../../data'
import { ALLERGEN_ITEMS } from '../students'
import { describeEvidenceError, substitutionEvidenceService, type StoredEvidence } from './substitutionEvidence'

/**
 * 선택한 후보의 참고 근거 조회 (임시 UI). 결과는 읽기 전용 참고 자료이며 대체식 확정 상태와 연결되지 않는다.
 * 요청에는 후보 식품명과 알레르기 번호 1개만 포함된다. 번호는 원래 메뉴 표기에 있는 번호 중에서 직접 고른다(미리 선택하지 않음).
 */
export function EvidencePanel({ candidateName, allergenOptions }: { candidateName: string; allergenOptions: AllergenNo[] }) {
  const [allergenNo, setAllergenNo] = useState<AllergenNo>()
  const [result, setResult] = useState<StoredEvidence>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!allergenNo) return
    let active = true
    void substitutionEvidenceService.getStored(candidateName, allergenNo).then((stored) => { if (active && stored) setResult(stored) })
    return () => { active = false }
  }, [candidateName, allergenNo])

  async function search() {
    if (!allergenNo) return
    setLoading(true); setError('')
    try { setResult(await substitutionEvidenceService.fetchEvidence(candidateName, allergenNo)) }
    catch (caught) { setError(describeEvidenceError(caught)) }
    finally { setLoading(false) }
  }

  const shown = result && result.foodName === candidateName && result.allergenNo === allergenNo ? result : undefined
  const meta = shown?.response
  return <div className="evidence-panel">
    <h4>참고 근거 찾기 <small>({candidateName})</small></h4>
    <p className="safety-notice">AI 검색 결과는 참고 자료일 뿐 안전성을 보장하지 않으며 대체식 확정에 영향을 주지 않습니다. 제품 표시와 교차접촉은 직접 확인하세요. 요청에는 후보 식품명과 선택한 알레르기 번호만 전송됩니다(학생 정보 없음).</p>
    {allergenOptions.length === 0 ? <p>원래 메뉴에 표기된 알레르기 번호가 없어 근거를 조회할 수 없습니다.</p> : <div className="narrative-controls">
      <label>알레르기 번호<select value={allergenNo ?? ''} onChange={(event) => { setAllergenNo(event.target.value ? Number(event.target.value) as AllergenNo : undefined); setError('') }}>
        <option value="">선택</option>{allergenOptions.map((no) => <option key={no} value={no}>{no}. {ALLERGEN_ITEMS.find((item) => item.no === no)?.name}</option>)}</select></label>
      <button type="button" disabled={!allergenNo || loading} onClick={() => void search()}>{loading ? '조회 중…' : shown ? '다시 조회' : '근거 찾기'}</button>
    </div>}
    {error && <p className="warning" role="alert">{error}</p>}
    {shown && meta && <div className="evidence-result">
      <p className="status-label">
        AI 참고 자료 · 조회 {new Date(shown.fetchedAt).toLocaleString('ko-KR')}
        {meta.simulated && <strong className="badge-simulated"> · 모의(simulated) 결과 — 실제 검색 결과가 아닙니다</strong>}
        {meta.sourceMissing && <strong className="badge-warning"> · 출처 없음(sourceMissing)</strong>}
        {meta.cached && ' · 캐시된 응답'}
      </p>
      <p className="evidence-text">{meta.text}</p>
      {meta.citations.length > 0 ? <ul className="citations">{meta.citations.map((citation) => <li key={citation.url}><a href={citation.url} target="_blank" rel="noopener noreferrer">{citation.title || citation.url}</a></li>)}</ul> : <p>제공된 출처가 없습니다. 이 내용을 근거로 사용하지 마세요.</p>}
    </div>}
  </div>
}
