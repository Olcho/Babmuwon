import { useEffect, useMemo, useRef, useState } from 'react'
import type { GeneratedDoc, YearMonth } from '../../data'
import { navigate } from '../../app/navigation'
import { Badge, Button, Field, Notice, PageHeader, SectionTitle } from '../../ui'
import { mealPlanService } from '../meal-plan/mealPlanService'
import { s2StateSync, type S2SendEligibility } from '../relay/s2StateSync'
import { DocumentPreview } from './DocumentPreview'
import { downloadDocumentXlsx } from './documentExporters'
import type { LocalDocumentArtifact, S2Document, S4Document, S5Document, SupportedDocumentType } from './documentModels'
import { downloadS4Pdf, downloadS4Zip } from './documentPdf'
import { documentService } from './documentService'
import { S2NarrativeEditor, S5NarrativeEditor } from './NarrativeEditor'

export { DocumentPreview } from './DocumentPreview'

const DOC_TABS: { type: SupportedDocumentType; title: string; formats: string }[] = [
  { type: 'S1', title: '월간·주간 식단표', formats: 'xlsx, PDF' },
  { type: 'S2', title: '월간 급식 가정통신문', formats: 'PDF' },
  { type: 'S3', title: '대체식 작업표(조리실)', formats: 'xlsx, PDF' },
  { type: 'S4', title: '대체식 개별 안내문', formats: 'PDF (zip)' },
  { type: 'S5', title: '식품알레르기 운영현황 보고', formats: 'xlsx, PDF' },
]

const now = new Date()

/** SC-06 문서 만들기 (Figma Frame 87). 생성·승인·stale·내보내기는 기존 documentService·exporter를 쓴다. */
export function DocumentPage() {
  const [type, setType] = useState<SupportedDocumentType>('S2')
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}` as YearMonth)
  const [year, setYear] = useState(`${now.getFullYear()}` as `${number}`)
  const [docs, setDocs] = useState<GeneratedDoc[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [eligibility, setEligibility] = useState<S2SendEligibility & { docId: string }>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const editorRef = useRef<HTMLDivElement>(null)

  async function refresh(selectId?: string) {
    const list = await documentService.list()
    setDocs(list)
    if (selectId) setSelectedId(selectId)
  }
  // 저장된 식단의 최신 월을 기본 대상 월로 쓴다. IndexedDB는 외부 저장소이므로 화면을 열 때 한 번 불러온다.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void refresh()
    void mealPlanService.listPlans().then((plans) => {
      const latest = plans[0]?.yearMonth
      if (latest) { setMonth(latest); setYear(latest.slice(0, 4) as `${number}`) }
    })
  }, [])

  const period = type === 'S5' ? year : month
  const versions = useMemo(() => docs.filter((doc) => doc.docType === type && doc.yearMonth === period).sort((a, b) => b.docVersion - a.docVersion || b.createdAt.localeCompare(a.createdAt)), [docs, type, period])
  const selected = versions.find((doc) => doc.id === selectedId) ?? versions[0]
  const artifact = selected?.content as LocalDocumentArtifact | undefined
  const unapproved = countUnapproved(artifact)

  useEffect(() => {
    let active = true
    if (selected?.docType !== 'S2') return
    const docId = selected.id
    void s2StateSync.checkSendEligibility(docId).then((value) => { if (active) setEligibility({ ...value, docId }) })
    return () => { active = false }
  }, [selected])

  async function run(action: () => Promise<string>) {
    setBusy(true); setMessage(''); setError('')
    try { setMessage(await action()) }
    catch (caught) { setError(caught instanceof Error ? caught.message : '처리하지 못했습니다.') }
    finally { setBusy(false) }
  }

  function generate() {
    void run(async () => {
      if (type === 'S4') {
        const result = await documentService.generateS4(month)
        await refresh(result.documents[0]?.id)
        return `S4 ${result.documents.length}건을 생성했습니다.${result.blockedStudentIds.length ? ` 미확정 대체식으로 제외된 학생 ${result.blockedStudentIds.length}명.` : ''}`
      }
      const doc = type === 'S1' ? await documentService.generateS1(month) : type === 'S2' ? await documentService.generateS2(month)
        : type === 'S3' ? await documentService.generateS3(month) : await documentService.generateS5(year)
      await refresh(doc.id)
      return `${type} 문서 v${doc.docVersion}을 이 브라우저에서 생성했습니다.`
    })
  }

  function approve() {
    if (!selected) return
    void run(async () => {
      try {
        const doc = await documentService.approve(selected.id)
        const sync = doc.docType === 'S2' ? await s2StateSync.syncMonth(doc.yearMonth) : undefined
        await refresh(doc.id)
        return `최신 기준 데이터와 일치하는 승인본으로 표시했습니다.${sync ? ` ${sync.message}` : ''}`
      } finally { await refresh(selected.id) }
    })
  }

  function exportDocument() {
    if (!selected || !artifact) return
    if (selected.status !== 'approved' && !window.confirm(`이 문서는 아직 승인되지 않았습니다(${statusLabel(selected.status)}).${unapproved ? ` 미승인 문장 ${unapproved}개가 있습니다.` : ''}\n그래도 내보낼까요?`)) return
    void run(async () => {
      if (artifact.type === 'S2') { window.print(); return 'PDF 저장·인쇄 창을 열었습니다.' }
      if (artifact.type === 'S4') {
        const latest = new Map<string, GeneratedDoc>()
        for (const doc of docs.filter((item) => item.docType === 'S4' && item.yearMonth === month && item.status !== 'stale' && item.content)) {
          const key = doc.subjectId ?? doc.id
          if (!latest.has(key) || latest.get(key)!.docVersion < doc.docVersion) latest.set(key, doc)
        }
        await downloadS4Zip([...latest.values()].map((doc) => doc.content as S4Document))
        return `학생별 안내문 ${latest.size}건을 ZIP으로 저장했습니다.`
      }
      downloadDocumentXlsx(artifact, selected.docVersion)
      return 'XLSX 파일을 저장했습니다.'
    })
  }

  const tab = DOC_TABS.find((item) => item.type === type)!

  return <div className="page">
    <PageHeader title="문서 만들기" actions={<Button size="lg" variant="primary" disabled={!artifact || busy} onClick={exportDocument}>내보내기</Button>} />
    <div className="docs-layout">
      <div className="stack" style={{ gap: 40 }}>
        <section>
          <SectionTitle>문서 선택</SectionTitle>
          <div className="doc-tabs" role="tablist">
            {DOC_TABS.map((item) => <button key={item.type} type="button" role="tab" aria-selected={item.type === type} className={`doc-tab${item.type === type ? ' is-active' : ''}`} onClick={() => { setType(item.type); setSelectedId(undefined); setMessage(''); setError('') }}>
              <strong>{item.title}</strong><span>{item.type} · {item.formats}</span>
            </button>)}
          </div>
        </section>

        <div className="doc-period">
          {type === 'S5' ? <Field label="대상 연도"><input type="number" min="2000" max="2100" value={year} onChange={(event) => { setYear(event.target.value as `${number}`); setSelectedId(undefined) }} /></Field>
            : <Field label="대상 월"><input type="month" value={month} onChange={(event) => { setMonth(event.target.value as YearMonth); setSelectedId(undefined) }} /></Field>}
          <Button variant={selected ? 'secondary' : 'primary'} disabled={busy} onClick={generate}>{selected ? `${tab.title} 다시 생성` : `${tab.title} 생성`}</Button>
          {type === 'S4' && selected && <Button disabled={busy} onClick={() => void run(async () => { await downloadS4Pdf(selected.content as S4Document); return '학생별 PDF를 저장했습니다.' })}>이 학생 PDF</Button>}
          {type !== 'S2' && type !== 'S4' && <Button disabled={busy || !selected} onClick={() => window.print()}>PDF 저장·인쇄</Button>}
        </div>

        {message && <Notice tone="success">{message}</Notice>}
        {error && <Notice tone="danger">{error}</Notice>}
        {selected?.status === 'stale' && <Notice tone="danger">재검토 필요: {selected.staleReason} 최신 데이터로 다시 생성해 주세요.</Notice>}

        {!artifact ? <div className="empty"><strong>{selected ? '이전 형식 문서에는 미리보기가 없습니다' : `${period} ${tab.title}이(가) 아직 없습니다`}</strong>
          {type === 'S1' || type === 'S2' ? '확정된 월간 식단이 있어야 생성할 수 있습니다.' : '확정 식단과 대체식 확정(확인 필요·재검토 0건)이 있어야 생성할 수 있습니다.'}</div>
          : <>
            {type === 'S4' && versions.length > 0 && <Field label="학생별 안내문"><select className="ds-input" value={selected?.id} onChange={(event) => setSelectedId(event.target.value)}>
              {latestPerSubject(versions).map((doc) => <option key={doc.id} value={doc.id}>{(doc.content as S4Document).recipient} · v{doc.docVersion} · {statusLabel(doc.status)}</option>)}
            </select></Field>}
            <DocumentPreview artifact={artifact} version={selected!.docVersion} />
            <div ref={editorRef}>
              {selected!.docType === 'S2' && <S2NarrativeEditor doc={selected!} onChanged={() => refresh(selected!.id)} />}
              {selected!.docType === 'S5' && <S5NarrativeEditor doc={selected!} onChanged={() => refresh(selected!.id)} />}
            </div>
          </>}
      </div>

      <aside className="approval-panel" aria-label="승인">
        <h2>마지막 확인을 부탁드려요.</h2>
        {!selected ? <p className="muted">문서를 생성하면 여기에서 승인할 수 있습니다.</p> : <>
          <p className={`approval-panel__headline${selected.status === 'stale' || unapproved ? ' is-danger' : ''}`}>
            {selected.status === 'approved' ? '승인 완료' : selected.status === 'stale' ? '재검토 필요 — 다시 생성해 주세요' : unapproved ? `미승인 문장 ${unapproved}개` : '승인 대기'}
          </p>
          <p className="muted" style={{ fontSize: 14 }}>승인해야 내보내기와 학부모 발송을 할 수 있어요.</p>
          <dl>
            <dt>문서</dt><dd>{selected.docType} v{selected.docVersion} · <span className={`status-pill status-pill--${selected.status}`}>{statusLabel(selected.status)}</span></dd>
            <dt>기준 버전</dt><dd>식단 {selected.basedOn.planVersion} / 학생 {selected.basedOn.studentVersion} / 대체식 {selected.basedOn.substitutionVersion}</dd>
            <dt>생성</dt><dd>{new Date(selected.generatedAt ?? selected.createdAt).toLocaleString('ko-KR')}</dd>
            {selected.docType === 'S2' && <><dt>Relay</dt><dd>{deliveryLabel(selected.s2DeliveryState)}</dd></>}
          </dl>
          {selected.docType === 'S2' && eligibility?.docId === selected.id && <Notice tone={eligibility.eligible ? 'success' : 'warning'}>{eligibility.eligible ? '실제 발송 조건 충족(Relay 동기화 완료)' : `실제 발송 불가 — ${eligibility.reason}`}</Notice>}
          <div className="approval-panel__actions">
            <Button variant="primary" disabled={busy || selected.status !== 'draft'} onClick={approve}>{selected.status === 'approved' ? '승인됨' : '승인'}</Button>
            <Button disabled={busy} onClick={generate}>다시 생성</Button>
            <Button disabled={busy || !['S2', 'S5'].includes(selected.docType) || selected.status !== 'draft'} onClick={() => editorRef.current?.scrollIntoView({ behavior: 'smooth' })}>직접 수정</Button>
          </div>
          {selected.docType === 'S2' && selected.status !== 'draft' && <Button disabled={busy} onClick={() => void run(async () => { const sync = await s2StateSync.syncMonth(selected.yearMonth, { force: true }); await refresh(selected.id); return sync.message })}>Relay 재동기화</Button>}
          {selected.docType === 'S2' && selected.status === 'approved' && <Button onClick={() => navigate('sending')}>학부모 발송으로 이동</Button>}
          {versions.length > 1 && type !== 'S4' && <div className="version-list"><span className="muted" style={{ fontSize: 13 }}>버전 기록</span>
            {versions.map((doc) => <button key={doc.id} type="button" className={doc.id === selected.id ? 'is-active' : ''} onClick={() => setSelectedId(doc.id)}><span>v{doc.docVersion} · {new Date(doc.createdAt).toLocaleString('ko-KR')}</span><span className={`status-pill status-pill--${doc.status}`}>{statusLabel(doc.status)}</span></button>)}
          </div>}
          {selected.docType === 'S2' && <Badge tone="neutral">발송 전 클릭 순간에 다시 검증합니다</Badge>}
        </>}
      </aside>
    </div>
  </div>
}

function countUnapproved(artifact?: LocalDocumentArtifact): number {
  if (!artifact) return 0
  if (artifact.type === 'S2') return (artifact as S2Document).narrativeSlots.filter((slot) => slot.state !== 'approved').length
  if (artifact.type === 'S5') return ((artifact as S5Document).narrativeSlots ?? []).filter((slot) => slot.state === 'draft').length
  return 0
}

function latestPerSubject(docs: GeneratedDoc[]): GeneratedDoc[] {
  const latest = new Map<string, GeneratedDoc>()
  for (const doc of docs) { const key = doc.subjectId ?? doc.id; if (!latest.has(key) || latest.get(key)!.docVersion < doc.docVersion) latest.set(key, doc) }
  return [...latest.values()]
}

function deliveryLabel(state: GeneratedDoc['s2DeliveryState']) { return { not_connected: '미연결', sync_required: '동기화 필요', synced: '동기화됨', sync_failed: '동기화 실패' }[state ?? 'not_connected'] }
function statusLabel(status: GeneratedDoc['status']) { return { draft: '초안', approved: '승인본', stale: '재검토 필요', sent: '발송됨' }[status] }
