import { Fragment, useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { GeneratedDoc, Guardian, SendRecipient } from '../../data'
import { navigate } from '../../app/navigation'
import { Badge, Button, Field, Notice, PageHeader, SectionTitle } from '../../ui'
import { DocumentPreview } from '../documents/DocumentPreview'
import type { LocalDocumentArtifact } from '../documents/documentModels'
import { importGuardiansFromWorkbook } from './guardianImport'
import { MAX_MOCK_RECIPIENTS, MAX_MOCK_RETRIES, maskPhone, mockSendService, type MockBatchView } from './mockSendService'

/**
 * SC-07 학부모 발송 (Figma Frame 88) — 로컬 Mock 시연.
 * 채널톡·알림톡·Relay 발송 API를 호출하지 않는다. 로직은 mockSendService에 있고 이 화면은 호출·표시만 한다.
 */
export function MockSendPage() {
  const [docs, setDocs] = useState<GeneratedDoc[]>([])
  const [docId, setDocId] = useState<string>()
  const [eligibility, setEligibility] = useState<{ eligible: boolean; reason?: string }>()
  const [preview, setPreview] = useState('')
  const [link, setLink] = useState('')
  const [guardians, setGuardians] = useState<Guardian[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [failing, setFailing] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ label: '', phone: '' })
  const [history, setHistory] = useState<MockBatchView[]>([])
  const [openBatch, setOpenBatch] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  const doc = docs.find((item) => item.id === docId)
  const sentBatch = history.find((view) => view.batch.docId === docId)

  async function reload(nextDocId = docId) {
    const [latest, people, views] = await Promise.all([mockSendService.listLatestS2(), mockSendService.listGuardians(), mockSendService.listHistory()])
    setDocs(latest); setGuardians(people); setHistory(views)
    setSelected((current) => current.filter((id) => people.some((guardian) => guardian.id === id)))
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

  async function act(action: () => Promise<string | void>, success: string) {
    setBusy(true); setError(''); setMessage('')
    try { setMessage((await action()) || success) }
    catch (caught) { setError(caught instanceof Error ? caught.message : '처리하지 못했습니다.') }
    finally { setBusy(false); await reload() }
  }

  function toggle(list: string[], id: string) { return list.includes(id) ? list.filter((item) => item !== id) : [...list, id] }

  function send() {
    if (!doc) return
    if (!window.confirm(`가상 보호자 ${selected.length}명에게 ${doc.yearMonth} 가정통신문(S2 v${doc.docVersion}) Mock 발송을 시뮬레이션합니다.\n실제 알림톡은 발송되지 않습니다. 계속할까요?`)) return
    void act(() => mockSendService.simulate(doc.id, selected, { failGuardianIds: failing, delayMs: 300, onProgress: () => void mockSendService.listHistory().then(setHistory) }).then((view) => { setOpenBatch(view.batch.id) }),
      `시뮬레이션 완료: 가상 보호자 ${selected.length}명 처리. 실제로 발송되지 않았습니다.`)
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    await act(async () => {
      const result = await importGuardiansFromWorkbook(mockSendService, await file.arrayBuffer())
      if (result.errors.length) setError(result.errors.slice(0, 5).join(' / '))
      return `가상 보호자 ${result.added}명을 추가했습니다.${result.errors.length ? ` 건너뛴 행 ${result.errors.length}개.` : ''}`
    }, '')
  }

  async function downloadManual(batchId: string) {
    await act(async () => {
      const files = await mockSendService.manualExportFiles(batchId)
      for (const file of [files.txt, files.csv]) {
        const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' }))
        const anchor = Object.assign(document.createElement('a'), { href: url, download: file.filename })
        anchor.click(); URL.revokeObjectURL(url)
      }
      return '수동 발송 파일(txt + csv)을 저장했습니다. 파일에는 연락처가 들어 있으니 이 기기 밖으로 옮기지 마세요.'
    }, '')
  }

  const allSelected = guardians.length > 0 && guardians.every((guardian) => selected.includes(guardian.id))

  return <div className="page stack stack--lg">
    <PageHeader title="학부모 발송" />
    <div className="stack" style={{ gap: 12, marginTop: -40 }}>
      <div className="ds-notice ds-notice--warning mock-banner" role="note">⚠ 로컬 시연용 Mock 발송입니다. 채널톡·카카오 알림톡으로 실제 발송되지 않으며, 모든 상태는 가상 시뮬레이션 결과입니다.</div>
      {message && <Notice tone="success">{message}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>

    <section className="stack" style={{ gap: 16 }}>
      <SectionTitle actions={<>
        <Button disabled={busy} onClick={() => fileInput.current?.click()}>엑셀 불러오기</Button>
        <input ref={fileInput} className="sr-only" type="file" accept=".xlsx" onChange={(event) => void importFile(event)} aria-label="보호자 엑셀 파일" />
        <Button disabled={busy} onClick={() => setAdding((value) => !value)}>직접 추가</Button>
        <Button disabled={busy} onClick={() => void act(() => mockSendService.addDemoGuardians().then(() => undefined), '가상 보호자 예시를 추가했습니다.')}>가상 예시 3명</Button>
      </>}>수신 대상</SectionTitle>
      <p className="subtle" style={{ fontSize: 14 }}>실제 연락처 대신 가상 이름과 010-0000-xxxx 같은 가상 번호만 쓰세요. 보호자는 학생·알레르기 정보와 연결되지 않습니다. 엑셀은 ‘이름표’·‘번호’ 열을 읽습니다.</p>
      {adding && <form className="row ds-card" style={{ padding: 20, alignItems: 'flex-end' }} onSubmit={(event) => { event.preventDefault(); void act(async () => { await mockSendService.addGuardian(form); setForm({ label: '', phone: '' }); setAdding(false) }, '가상 보호자를 추가했습니다.') }}>
        <Field label="이름표"><input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder="1학년 2반 학부모" /></Field>
        <Field label="가상 번호"><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="010-0000-0004" /></Field>
        <Button type="submit" variant="primary" disabled={busy}>추가</Button>
      </form>}
      {guardians.length === 0 ? <div className="empty"><strong>등록된 수신 대상이 없습니다</strong>‘직접 추가’, ‘엑셀 불러오기’ 또는 ‘가상 예시 3명’을 사용하세요.</div>
        : <div className="ds-table-wrap ds-table-wrap--flat"><table className="ds-table"><thead><tr>
          <th style={{ width: 60 }}><input type="checkbox" aria-label="전체 선택" checked={allSelected} onChange={() => setSelected(allSelected ? [] : guardians.slice(0, MAX_MOCK_RECIPIENTS).map((item) => item.id))} /></th>
          <th style={{ width: '40%' }}>이름표</th><th>번호</th><th>가상 실패로 처리</th><th className="sr-only">관리</th></tr></thead><tbody>
          {guardians.map((guardian) => <tr key={guardian.id} className={selected.includes(guardian.id) ? 'is-selected' : ''}>
            <td><input type="checkbox" aria-label={`${guardian.label} 선택`} checked={selected.includes(guardian.id)} onChange={() => setSelected(toggle(selected, guardian.id))} /></td>
            <td>{guardian.label}</td><td>{maskPhone(guardian.phone)}</td>
            <td><input type="checkbox" aria-label={`${guardian.label} 가상 실패`} checked={failing.includes(guardian.id)} onChange={() => setFailing(toggle(failing, guardian.id))} /></td>
            <td><div className="cell-actions"><Button size="sm" disabled={busy} onClick={() => void act(() => mockSendService.removeGuardian(guardian.id), '가상 보호자를 삭제했습니다.')}>삭제</Button></div></td>
          </tr>)}
        </tbody></table></div>}
    </section>

    <section className="stack" style={{ gap: 16 }}>
      <SectionTitle>발송 문구</SectionTitle>
      {docs.length === 0 ? <div className="empty"><strong>생성된 가정통신문(S2)이 없습니다</strong>문서 만들기에서 S2를 생성하고 승인해 주세요.<div style={{ marginTop: 16 }}><Button onClick={() => navigate('documents')}>문서 만들기</Button></div></div> : <>
        <div className="row">
          <Field label="보낼 가정통신문"><select className="ds-input" value={docId} onChange={(event) => void reload(event.target.value)}>{docs.map((item) => <option key={item.id} value={item.id}>{item.yearMonth} · S2 v{item.docVersion} · {docStatus(item.status)}</option>)}</select></Field>
          {eligibility && <Badge tone={eligibility.eligible ? 'success' : 'danger'}>{eligibility.eligible ? '최신 승인본 · Mock 발송 가능' : 'Mock 발송 불가'}</Badge>}
        </div>
        {eligibility && !eligibility.eligible && <Notice tone="danger">{eligibility.reason} — 승인된 최신 S2만 보낼 수 있습니다.</Notice>}
        <div className="send-message">
          <p>{preview}</p>
          <p className="send-message__link">[가정통신문 보기] → {link.trim() || '(링크 미입력)'}</p>
        </div>
        <input className="ds-input" style={{ fontSize: 16 }} value={link} onChange={(event) => setLink(event.target.value)} placeholder="링크 입력 (Mock 미리보기용 · 저장하지 않음)" aria-label="가정통신문 링크" />
        {doc?.content && <details><summary className="subtle" style={{ cursor: 'pointer' }}>가정통신문(S2) 미리보기</summary><div className="ds-card" style={{ marginTop: 12 }}><DocumentPreview artifact={doc.content as LocalDocumentArtifact} version={doc.docVersion} /></div></details>}
      </>}
    </section>

    <div className="send-confirm">
      <div><strong>발송 확인</strong><span>수신 대상 {selected.length}명 (최대 {MAX_MOCK_RECIPIENTS}명){failing.some((id) => selected.includes(id)) ? ` · 가상 실패 ${failing.filter((id) => selected.includes(id)).length}명` : ''}</span></div>
      <Button size="lg" variant="primary" disabled={busy || !doc || !eligibility?.eligible || selected.length === 0 || selected.length > MAX_MOCK_RECIPIENTS || Boolean(sentBatch)} onClick={send}>
        {busy ? '시뮬레이션 중…' : sentBatch ? '이 버전은 이미 Mock 발송됨' : 'Mock 발송'}</Button>
    </div>
    {sentBatch && <Notice>같은 S2 버전은 한 번만 시뮬레이션할 수 있습니다. 실패 건은 아래 기록에서 재시도하고, 정정은 새 S2를 승인해 보내세요.</Notice>}

    <section className="stack" style={{ gap: 16 }}>
      <SectionTitle actions={<Button disabled={busy || !history[0]} onClick={() => history[0] && void downloadManual(openBatch ?? history[0].batch.id)}>수동 발송 파일 받기 (txt + csv)</Button>}>발송 기록</SectionTitle>
      {history.length === 0 ? <div className="empty"><strong>발송 기록이 없습니다</strong>Mock 발송을 시뮬레이션하면 여기에 기록됩니다.</div>
        : <div className="ds-table-wrap ds-table-wrap--flat"><table className="ds-table"><thead><tr><th>시각</th><th>채널</th><th>문서</th><th>대상</th><th>Mock 성공</th><th>가상 실패</th><th>상태</th></tr></thead><tbody>
          {history.map((view) => <Fragment key={view.batch.id}>
            <tr className={`is-clickable${openBatch === view.batch.id ? ' is-selected' : ''}`} onClick={() => setOpenBatch(openBatch === view.batch.id ? undefined : view.batch.id)}>
              <td>{formatTime(view.batch.createdAt)}</td><td>알림톡 (Mock)</td><td>{view.month} · S2 v{view.batch.docVersion}</td>
              <td>{view.totals.count}</td><td>{view.totals.requested}</td><td>{view.totals.failed}</td>
              <td>{view.correctionNeeded ? <Badge tone="danger">정정 안내 필요</Badge> : <Badge tone={view.batch.status === 'requested' ? 'primary' : 'neutral'}>{batchLabel(view.batch.status)}</Badge>}</td>
            </tr>
            {openBatch === view.batch.id && <tr className="recipient-detail"><td colSpan={7}>
              {view.correctionNeeded && <Notice tone="danger">발송한 S2가 더는 최신 승인본이 아닙니다: {view.correctionReason} 새 S2를 승인한 뒤 새 버전으로 다시 시뮬레이션하세요.</Notice>}
              <table className="ds-table"><thead><tr><th>보호자</th><th>번호</th><th>요청 상태</th><th>도착 상태</th><th>재시도</th><th>시도 이력</th><th className="sr-only">관리</th></tr></thead><tbody>
                {view.recipients.map(({ recipient, guardianLabel, maskedPhone, retryable }) => <tr key={recipient.id}>
                  <td>{guardianLabel}</td><td>{maskedPhone}</td><td>{requestLabel(recipient)}</td><td>{deliveryLabel(recipient)}</td>
                  <td>{recipient.retryCount}/{MAX_MOCK_RETRIES}</td>
                  <td>{(recipient.attempts ?? []).map((attempt) => (attempt.result === 'requested' ? '성공' : '실패')).join(' → ') || '—'}</td>
                  <td><div className="cell-actions">
                    {recipient.requestStatus === 'request_failed' && <Button size="sm" disabled={busy || !retryable} onClick={() => void act(() => mockSendService.retry(view.batch.id, [recipient.id], { failGuardianIds: failing, delayMs: 300 }).then(() => undefined), '가상 재시도를 완료했습니다. 실제로 발송되지 않았습니다.')}>가상 재시도</Button>}
                    {recipient.requestStatus === 'requested' && recipient.deliveryStatus === 'unknown' && <>
                      <Button size="sm" disabled={busy} onClick={() => void act(() => mockSendService.markDelivery(recipient.id, 'delivered'), '가상 도착 확인을 기록했습니다.')}>가상 도착 확인</Button>
                      <Button size="sm" disabled={busy} onClick={() => void act(() => mockSendService.markDelivery(recipient.id, 'failed'), '가상 미도착을 기록했습니다.')}>미도착</Button>
                    </>}
                  </div></td>
                </tr>)}
              </tbody></table>
            </td></tr>}
          </Fragment>)}
        </tbody></table></div>}
    </section>
  </div>
}

function formatTime(iso: string) { const d = new Date(iso); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
function docStatus(status: GeneratedDoc['status']) { return { draft: '초안', approved: '승인본', stale: '재검토 필요', sent: '발송됨' }[status] }
function batchLabel(status: string) { return ({ requesting: 'Mock 처리 중', requested: '시뮬레이션 완료', partial: '일부 가상 실패', closed: '종료', manual: '수동' } as Record<string, string>)[status] ?? status }
function requestLabel(recipient: SendRecipient) {
  if (recipient.requestStatus === 'pending') return '대기'
  if (recipient.requestStatus === 'requested') return 'Mock 발송 성공'
  return `Mock 발송 실패(가상${recipient.errorCode === 'MOCK_INTERRUPTED' ? ' · 중단됨' : ''})`
}
function deliveryLabel(recipient: SendRecipient) { return { unknown: '도착 미확인', delivered: '가상 도착 확인', failed: '가상 미도착' }[recipient.deliveryStatus] }
