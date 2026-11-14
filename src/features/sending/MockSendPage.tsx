import { useEffect, useState } from 'react'
import type { GeneratedDoc, Guardian, SendRecipient } from '../../data'
import { DocumentPreview } from '../documents/DocumentPage'
import type { LocalDocumentArtifact } from '../documents/documentModels'
import { MAX_MOCK_RECIPIENTS, MAX_MOCK_RETRIES, mockSendService, type MockBatchView } from './mockSendService'

/** SC-07 학부모 발송 — Mock 시연 임시 UI. 로직은 mockSendService에 있고 이 화면은 호출·표시만 한다. */
export function MockSendPage() {
  const [docs, setDocs] = useState<GeneratedDoc[]>([])
  const [docId, setDocId] = useState<string>()
  const [eligibility, setEligibility] = useState<{ eligible: boolean; reason?: string }>()
  const [preview, setPreview] = useState('')
  const [guardians, setGuardians] = useState<Guardian[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [failing, setFailing] = useState<string[]>([])
  const [form, setForm] = useState({ label: '', phone: '' })
  const [history, setHistory] = useState<MockBatchView[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const doc = docs.find((item) => item.id === docId)
  const sentBatch = history.find((view) => view.batch.docId === docId)

  async function reload(nextDocId = docId) {
    const [latest, people, views] = await Promise.all([mockSendService.listLatestS2(), mockSendService.listGuardians(), mockSendService.listHistory()])
    setDocs(latest); setGuardians(people); setHistory(views)
    const target = latest.find((item) => item.id === nextDocId) ?? latest[0]
    setDocId(target?.id)
    if (target) {
      const [check, text] = await Promise.all([mockSendService.checkEligibility(target.id), mockSendService.previewText(target)])
      setEligibility({ eligible: check.eligible, reason: check.reason }); setPreview(text)
    } else { setEligibility(undefined); setPreview('') }
  }
  // IndexedDB는 외부 저장소이므로 화면을 열 때 한 번 불러온다.
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void reload() }, [])

  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(''); setMessage('')
    try { await action(); setMessage(success) }
    catch (caught) { setError(caught instanceof Error ? caught.message : '처리하지 못했습니다.') }
    finally { setBusy(false); await reload() }
  }

  function toggle(list: string[], id: string) { return list.includes(id) ? list.filter((item) => item !== id) : [...list, id] }

  function send() {
    if (!doc) return
    if (!window.confirm(`가상 보호자 ${selected.length}명에게 ${doc.yearMonth} S2 v${doc.docVersion} Mock 발송을 시뮬레이션합니다.\n실제 알림톡은 발송되지 않습니다. 계속할까요?`)) return
    void act(() => mockSendService.simulate(doc.id, selected, { failGuardianIds: failing, delayMs: 300, onProgress: () => void mockSendService.listHistory().then(setHistory) }),
      `시뮬레이션 완료: 가상 보호자 ${selected.length}명 처리. 실제로 발송되지 않았습니다.`)
  }

  return <main className="page-shell mock-send-page">
    <header className="page-header"><div><p className="eyebrow">SC-07 · Mock 시연</p><h1>학부모 발송 (Mock 시뮬레이션)</h1>
      <p>로컬 시연 전용입니다. 채널톡·카카오 알림톡·Relay 발송 API를 호출하지 않으며, 가상 보호자 정보는 이 브라우저 밖으로 나가지 않습니다.</p></div></header>
    <p className="warning mock-banner" role="note">⚠ 실제 발송이 아닙니다. 아래의 모든 상태는 가상 시뮬레이션 결과이며 실제 수신을 의미하지 않습니다.</p>
    {message && <p className="notice" role="status">{message}</p>}
    {error && <p className="error-panel" role="alert">{error}</p>}

    <section className="mock-section">
      <h2>1. 보낼 S2 가정통신문</h2>
      {docs.length === 0 ? <p>생성된 S2가 없습니다. 문서 생성 화면에서 S2를 만들고 승인해 주세요.</p> : <>
        <label>대상 월<select value={docId} onChange={(event) => void reload(event.target.value)}>{docs.map((item) => <option key={item.id} value={item.id}>{item.yearMonth} · S2 v{item.docVersion} · {statusLabel(item.status)}</option>)}</select></label>
        {eligibility && <p className={eligibility.eligible ? 'notice' : 'warning'}>{eligibility.eligible ? 'Mock 발송 가능: 최신 승인본이며 현재 식단과 일치합니다.' : `Mock 발송 불가 — ${eligibility.reason}`}</p>}
        <p className="status-label">실제 발송은 이 검증에 더해 Relay 승인 상태 동기화가 필요하지만, Mock 시연은 로컬 검증만 사용합니다.</p>
        <div className="mock-preview"><h3>알림톡 미리보기 (Mock)</h3><p>{preview}</p><small>버튼: 이달의 가정통신문 보기 (고정 URL, Mock)</small></div>
        {doc?.content && <details><summary>S2 가정통신문 미리보기</summary><DocumentPreview artifact={doc.content as LocalDocumentArtifact} version={doc.docVersion} /></details>}
      </>}
    </section>

    <section className="mock-section">
      <h2>2. 가상 보호자 (수신 대상)</h2>
      <p className="safety-notice">실제 연락처를 입력하지 마세요. 시연용 가상 이름과 010-0000-xxxx 같은 가상 번호만 사용합니다. 보호자는 학생·알레르기 정보와 연결되지 않습니다.</p>
      <div className="narrative-controls">
        <label>표시명<input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder="예: 가상 보호자 D" /></label>
        <label>가상 전화번호<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="010-0000-0004" /></label>
        <button disabled={busy} onClick={() => void act(async () => { await mockSendService.addGuardian(form); setForm({ label: '', phone: '' }) }, '가상 보호자를 추가했습니다.')}>추가</button>
        <button disabled={busy} onClick={() => void act(() => mockSendService.addDemoGuardians(), '가상 보호자 예시를 추가했습니다.')}>가상 보호자 예시 3명 추가</button>
      </div>
      {guardians.length === 0 ? <p>등록된 가상 보호자가 없습니다.</p> : <table><thead><tr><th>선택</th><th>표시명</th><th>전화번호</th><th>가상 실패로 처리</th><th /></tr></thead><tbody>
        {guardians.map((guardian) => <tr key={guardian.id}>
          <td><input type="checkbox" checked={selected.includes(guardian.id)} onChange={() => setSelected(toggle(selected, guardian.id))} /></td>
          <td>{guardian.label}</td><td>{guardian.phone}</td>
          <td><input type="checkbox" checked={failing.includes(guardian.id)} onChange={() => setFailing(toggle(failing, guardian.id))} /></td>
          <td><button disabled={busy} onClick={() => void act(async () => { await mockSendService.removeGuardian(guardian.id); setSelected((list) => list.filter((id) => id !== guardian.id)) }, '가상 보호자를 삭제했습니다.')}>삭제</button></td>
        </tr>)}
      </tbody></table>}
    </section>

    <section className="mock-section">
      <h2>3. Mock 발송 시뮬레이션</h2>
      <p>선택한 가상 보호자 <strong>{selected.length}명</strong> (최대 {MAX_MOCK_RECIPIENTS}명)</p>
      {sentBatch && <p className="notice">이 S2 버전은 이미 Mock 발송 기록이 있습니다. 같은 버전은 한 번만 시뮬레이션할 수 있으며, 실패 건은 아래 이력에서 재시도하세요.</p>}
      <button className="primary" disabled={busy || !doc || !eligibility?.eligible || selected.length === 0 || selected.length > MAX_MOCK_RECIPIENTS || Boolean(sentBatch)} onClick={send}>
        {busy ? '시뮬레이션 중…' : 'Mock 발송 시뮬레이션'}</button>
    </section>

    <section className="mock-section">
      <h2>4. Mock 발송 이력</h2>
      {history.length === 0 ? <p>Mock 발송 이력이 없습니다.</p> : history.map((view) => <article key={view.batch.id} className="narrative-card">
        <h3>{view.month} · S2 v{view.batch.docVersion} <span className="doc-status draft">{batchLabel(view.batch.status)}</span></h3>
        <p className="status-label">Mock 기록 · {new Date(view.batch.createdAt).toLocaleString('ko-KR')} · 대상 {view.totals.count} / Mock 성공 {view.totals.requested} / 가상 실패 {view.totals.failed} / 대기 {view.totals.pending} / 가상 도착 확인 {view.totals.delivered}</p>
        {view.correctionNeeded && <p className="warning">정정 안내 필요 — {view.correctionReason} 새 S2를 승인한 뒤 새 버전으로 다시 시뮬레이션하세요.</p>}
        <table><thead><tr><th>보호자</th><th>번호</th><th>요청 상태</th><th>도착 상태</th><th>재시도</th><th>시도 이력</th><th /></tr></thead><tbody>
          {view.recipients.map(({ recipient, guardianLabel, maskedPhone, retryable }) => <tr key={recipient.id}>
            <td>{guardianLabel}</td><td>{maskedPhone}</td><td>{requestLabel(recipient)}</td><td>{deliveryLabel(recipient)}</td>
            <td>{recipient.retryCount}/{MAX_MOCK_RETRIES}</td>
            <td>{(recipient.attempts ?? []).map((attempt) => attempt.result === 'requested' ? '성공' : '실패').join(' → ') || '—'}</td>
            <td>
              {recipient.requestStatus === 'request_failed' && <button disabled={busy || !retryable} onClick={() => void act(() => mockSendService.retry(view.batch.id, [recipient.id], { failGuardianIds: failing, delayMs: 300 }), '가상 재시도를 완료했습니다. 실제로 발송되지 않았습니다.')}>가상 재시도</button>}
              {recipient.requestStatus === 'requested' && recipient.deliveryStatus === 'unknown' && <>
                <button disabled={busy} onClick={() => void act(() => mockSendService.markDelivery(recipient.id, 'delivered'), '가상 도착 확인을 기록했습니다.')}>가상 도착 확인</button>
                <button disabled={busy} onClick={() => void act(() => mockSendService.markDelivery(recipient.id, 'failed'), '가상 미도착을 기록했습니다.')}>미도착</button>
              </>}
            </td>
          </tr>)}
        </tbody></table>
      </article>)}
    </section>
  </main>
}

function statusLabel(status: GeneratedDoc['status']) { return { draft: '초안', approved: '승인본', stale: '재검토 필요', sent: '발송됨' }[status] }
function batchLabel(status: string) { return ({ requesting: 'Mock 처리 중', requested: '시뮬레이션 완료', partial: '시뮬레이션 완료(일부 가상 실패)', closed: '종료', manual: '수동' } as Record<string, string>)[status] ?? status }
function requestLabel(recipient: SendRecipient) {
  if (recipient.requestStatus === 'pending') return '대기'
  if (recipient.requestStatus === 'requested') return 'Mock 발송 성공'
  return `Mock 발송 실패(가상${recipient.errorCode === 'MOCK_INTERRUPTED' ? ' · 중단됨' : ''})`
}
function deliveryLabel(recipient: SendRecipient) {
  return { unknown: '도착 미확인', delivered: '가상 도착 확인', failed: '가상 미도착' }[recipient.deliveryStatus]
}
