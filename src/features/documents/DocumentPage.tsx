import { useEffect, useState } from 'react'
import type { GeneratedDoc, YearMonth } from '../../data'
import { documentService, downloadDocumentXlsx, downloadS4Pdf, downloadS4Zip, type LocalDocumentArtifact, type S2Document, type S4Document, type SupportedDocumentType } from '.'

const initialDate = new Date()

export function DocumentPage() {
  const [month, setMonth] = useState(`${initialDate.getFullYear()}-${String(initialDate.getMonth() + 1).padStart(2, '0')}` as YearMonth)
  const [year, setYear] = useState(`${initialDate.getFullYear()}` as `${number}`)
  const [docs, setDocs] = useState<GeneratedDoc[]>([])
  const [selected, setSelected] = useState<GeneratedDoc>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh(selectId?: string) {
    const list = await documentService.list()
    setDocs(list)
    setSelected(list.find((item) => item.id === selectId) ?? list[0])
  }
  // IndexedDB is an external persistent store; load it once when this screen mounts.
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void refresh() }, [])

  async function generate(type: SupportedDocumentType) {
    setBusy(true); setMessage('')
    try {
      if (type === 'S4') {
        const result = await documentService.generateS4(month)
        await refresh(result.documents[0]?.id)
        setMessage(`S4 ${result.documents.length}건을 생성했습니다.${result.blockedStudentIds.length ? ` 미확정 대체식으로 제외된 학생 ${result.blockedStudentIds.length}명.` : ''}`)
        return
      }
      const doc = type === 'S1' ? await documentService.generateS1(month)
        : type === 'S2' ? await documentService.generateS2(month)
          : type === 'S3' ? await documentService.generateS3(month)
            : await documentService.generateS5(year)
      await refresh(doc.id)
      setMessage(`${type} 문서 v${doc.docVersion}을 로컬에서 생성했습니다.`)
    } catch (error) { setMessage(error instanceof Error ? error.message : '문서를 생성하지 못했습니다.') }
    finally { setBusy(false) }
  }

  async function approve() {
    if (!selected) return
    try { const doc = await documentService.approve(selected.id); await refresh(doc.id); setMessage('최신 기준 데이터와 일치하는 승인본으로 표시했습니다.') }
    catch (error) { setMessage(error instanceof Error ? error.message : '승인하지 못했습니다.'); await refresh(selected.id) }
  }

  function download() {
    if (!selected?.content) return
    downloadDocumentXlsx(selected.content as LocalDocumentArtifact, selected.docVersion)
  }

  async function downloadIndividualPdf() {
    if (selected?.docType !== 'S4' || !selected.content) return
    setBusy(true)
    try { await downloadS4Pdf(selected.content as S4Document) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'PDF를 생성하지 못했습니다.') }
    finally { setBusy(false) }
  }

  async function downloadZip() {
    const latest = new Map<string, GeneratedDoc>()
    for (const doc of docs.filter((item) => item.docType === 'S4' && item.yearMonth === month && item.status !== 'stale' && item.content)) {
      const key = doc.subjectId ?? doc.id
      if (!latest.has(key) || latest.get(key)!.docVersion < doc.docVersion) latest.set(key, doc)
    }
    const artifacts = [...latest.values()].map((doc) => doc.content as S4Document)
    setBusy(true)
    try { await downloadS4Zip(artifacts) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'ZIP을 생성하지 못했습니다.') }
    finally { setBusy(false) }
  }

  return <main className="page-shell document-page">
    <header className="page-header"><div><p className="eyebrow">SC-06 · S1~S5</p><h1>문서 자동 생성</h1><p>모든 생성과 다운로드는 이 브라우저 안에서 처리됩니다.</p></div></header>
    {message && <p className="notice" role="status">{message}</p>}
    <section className="document-controls no-print">
      <label>대상 월<input type="month" value={month} onChange={(event) => setMonth(event.target.value as YearMonth)} /></label>
      <button disabled={busy} onClick={() => void generate('S1')}>월간·주간 식단표 생성</button>
      <button disabled={busy} onClick={() => void generate('S2')}>가정통신문 생성</button>
      <button disabled={busy} onClick={() => void generate('S3')}>내부 작업표 생성</button>
      <button disabled={busy} onClick={() => void generate('S4')}>개별 안내문 생성</button>
      <button disabled={busy} onClick={() => void downloadZip()}>S4 PDF ZIP 다운로드</button>
      <label>대상 연도<input type="number" min="2000" max="2100" value={year} onChange={(event) => setYear(event.target.value as `${number}`)} /></label>
      <button disabled={busy} onClick={() => void generate('S5')}>연간 운영 보고서 생성</button>
    </section>
    <section className="document-workspace">
      <aside className="document-list no-print"><h2>생성 문서</h2>{docs.length === 0 ? <p>아직 생성된 문서가 없습니다.</p> : docs.map((doc) => <button key={doc.id} className={selected?.id === doc.id ? 'active' : ''} onClick={() => setSelected(doc)}><strong>{doc.docType} · {doc.yearMonth}</strong><span>v{doc.docVersion} · {statusLabel(doc.status)}</span></button>)}</aside>
      <section className="document-preview">
        {!selected?.content ? <div className="empty-state"><h2>문서를 선택해 주세요</h2></div> : <>
          <div className="document-actions no-print"><span className={`doc-status ${selected.status}`}>{statusLabel(selected.status)}</span>{!['S2', 'S4'].includes(selected.docType) && <button onClick={download}>XLSX 다운로드</button>}{selected.docType === 'S4' && <button disabled={busy} onClick={() => void downloadIndividualPdf()}>학생별 PDF</button>}<button onClick={() => window.print()}>PDF 저장·인쇄</button><button className="primary" disabled={selected.status !== 'draft'} onClick={() => void approve()}>승인</button></div>
          {selected.status === 'stale' && <p className="warning">재검토 필요: {selected.staleReason}</p>}
          <DocumentPreview artifact={selected.content as LocalDocumentArtifact} version={selected.docVersion} />
        </>}
      </section>
    </section>
  </main>
}

function DocumentPreview({ artifact, version }: { artifact: LocalDocumentArtifact; version: number }) {
  return <article className="print-sheet">
    <header><h2>{artifact.title}</h2><p>문서 v{version} · 생성 {new Date(artifact.generatedAt).toLocaleString('ko-KR')}</p><p>기준 버전: 식단 {artifact.basedOn.planVersion} / 학생 {artifact.basedOn.studentVersion} / 대체식 {artifact.basedOn.substitutionVersion}</p></header>
    {artifact.type === 'S1' ? <MealTable rows={artifact.rows} slots={artifact.slots} />
      : artifact.type === 'S2' ? <S2Preview artifact={artifact} />
        : artifact.type === 'S3' ? <table><thead><tr><th>날짜</th><th>학생</th><th>기존 메뉴</th><th>대체식</th><th>충돌 번호</th><th>확인 사항</th></tr></thead><tbody>{artifact.rows.map((row, index) => <tr key={`${row.date}-${index}`}><td>{row.date}</td><td>{row.studentDisplay}</td><td>{row.originalMenu}</td><td>{row.substituteMenu}</td><td>{row.allergenNos.join('.')}</td><td>{row.caution}</td></tr>)}</tbody></table>
          : artifact.type === 'S4' ? <S4Preview artifact={artifact} />
            : <><p className="report-text">{artifact.reportText}</p><div className="summary"><div><span>관리 학생</span><strong>{artifact.totalStudents}명</strong></div><div><span>대체식 제공</span><strong>{artifact.providedCount}건</strong></div><div><span>제외 처리</span><strong>{artifact.excludedCount}건</strong></div></div><h3>알레르기 유발식품별 현황</h3><table><thead><tr><th>번호</th><th>항목</th><th>학생 수</th></tr></thead><tbody>{artifact.byAllergen.map((item) => <tr key={item.allergenNo}><td>{item.allergenNo}</td><td>{item.name}</td><td>{item.students}</td></tr>)}</tbody></table></>}
  </article>
}

function MealTable({ rows, slots }: { rows: S2Document['mealTable']['rows']; slots: string[] }) {
  return <table><thead><tr><th>날짜</th><th>요일</th>{slots.map((slot) => <th key={slot}>{slot}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.date}><td>{row.date}</td><td>{row.weekday}</td>{row.menus.map((menu) => <td key={menu.slot}>{menu.label || '—'}</td>)}</tr>)}</tbody></table>
}

function S2Preview({ artifact }: { artifact: S2Document }) {
  return <><section><p>{artifact.school.motto}</p><p>{artifact.school.name} · {artifact.school.address} · {artifact.school.phone} · {artifact.school.homepage}</p><p>{artifact.greeting}</p><MealTable rows={artifact.mealTable.rows} slots={artifact.mealTable.slots} /><p>{artifact.allergenNotice}</p><ol>{artifact.mealTable.legend.map((item) => <li key={item.no}>{item.no}. {item.name}</li>)}</ol><p>{artifact.contact}</p></section><section className="document-page-break"><h2>이달의 소식</h2>{artifact.narrativeSlots.map((slot) => <div className="narrative-missing" key={slot.key}><h3>{slot.label}</h3><p>{slot.state === 'not_generated' ? 'AI 문구 미생성 — 현재 단계에서는 외부 AI를 호출하지 않습니다.' : slot.text}</p></div>)}<p className="narrative-missing">Relay `/local/s2-state` 연동 전이므로 이 문서는 발송할 수 없습니다.</p></section></>
}

function S4Preview({ artifact }: { artifact: S4Document }) {
  return <><p><strong>{artifact.recipient}</strong></p><p>대상 알레르기: {artifact.allergens.map((item) => `${item.no}. ${item.name}`).join(', ')}</p><p>{artifact.confirmationText}</p><table><thead><tr><th>날짜</th><th>기존 메뉴</th><th>확정 대체 메뉴</th><th>충돌 번호</th></tr></thead><tbody>{artifact.rows.map((row, index) => <tr key={`${row.date}-${index}`}><td>{row.date}</td><td>{row.originalMenu}</td><td>{row.substituteMenu}</td><td>{row.allergenNos.join('.')}</td></tr>)}</tbody></table></>
}

function statusLabel(status: GeneratedDoc['status']) { return { draft: '초안', approved: '승인본', stale: '재검토 필요', sent: '발송됨' }[status] }
