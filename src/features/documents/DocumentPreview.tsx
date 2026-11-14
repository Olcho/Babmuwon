import { reportBodyText } from './documentBuilders'
import type { LocalDocumentArtifact, S2Document, S4Document } from './documentModels'

/** 문서 미리보기(S1~S5). 문서 화면과 학부모 발송 화면이 함께 쓴다. */
export function DocumentPreview({ artifact, version }: { artifact: LocalDocumentArtifact; version: number }) {
  return <article className="print-sheet">
    <header><h2>{artifact.title}</h2><p>문서 v{version} · 생성 {new Date(artifact.generatedAt).toLocaleString('ko-KR')}</p><p>기준 버전: 식단 {artifact.basedOn.planVersion} / 학생 {artifact.basedOn.studentVersion} / 대체식 {artifact.basedOn.substitutionVersion}</p></header>
    {artifact.type === 'S1' ? <MealTable rows={artifact.rows} slots={artifact.slots} />
      : artifact.type === 'S2' ? <S2Preview artifact={artifact} />
        : artifact.type === 'S3' ? <table><thead><tr><th>날짜</th><th>학생</th><th>기존 메뉴</th><th>대체식</th><th>충돌 번호</th><th>확인 사항</th></tr></thead><tbody>{artifact.rows.map((row, index) => <tr key={`${row.date}-${index}`}><td>{row.date}</td><td>{row.studentDisplay}</td><td>{row.originalMenu}</td><td>{row.substituteMenu}</td><td>{row.allergenNos.join('.')}</td><td>{row.caution}</td></tr>)}</tbody></table>
          : artifact.type === 'S4' ? <S4Preview artifact={artifact} />
            : <><p className="report-text">{reportBodyText(artifact)}</p>{artifact.narrativeSlots?.map((slot) => slot.state !== 'not_generated' && <p className="narrative-meta" key={slot.key}>{slot.state === 'approved' ? '승인된 본문' : '검토 중인 초안(승인 전 — 아직 반영되지 않음)'}{slot.simulated ? ' · 모의 결과' : ''}{slot.sourceMissing ? ' · 출처 없음' : ''}</p>)}<div className="summary"><div><span>관리 학생</span><strong>{artifact.totalStudents}명</strong></div><div><span>대체식 제공</span><strong>{artifact.providedCount}건</strong></div><div><span>제외 처리</span><strong>{artifact.excludedCount}건</strong></div></div><h3>알레르기 유발식품별 현황</h3><table><thead><tr><th>번호</th><th>항목</th><th>학생 수</th></tr></thead><tbody>{artifact.byAllergen.map((item) => <tr key={item.allergenNo}><td>{item.allergenNo}</td><td>{item.name}</td><td>{item.students}</td></tr>)}</tbody></table></>}
  </article>
}

function MealTable({ rows, slots }: { rows: S2Document['mealTable']['rows']; slots: string[] }) {
  return <table><thead><tr><th>날짜</th><th>요일</th>{slots.map((slot) => <th key={slot}>{slot}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.date}><td>{row.date}</td><td>{row.weekday}</td>{row.menus.map((menu) => <td key={menu.slot}>{menu.label || '—'}</td>)}</tr>)}</tbody></table>
}

function S2Preview({ artifact }: { artifact: S2Document }) {
  const slots = artifact.mealTable.slots
  return <>
    <section>
      <p className="doc-preview-label">가정통신문 미리보기 · 제{artifact.issueNo}호</p>
      <p style={{ color: 'var(--c-primary)', fontSize: 18, fontWeight: 700 }}>{artifact.school.name}</p>
      <p className="subtle" style={{ fontSize: 14 }}>{artifact.school.motto} · {artifact.school.address} · {artifact.school.phone} · {artifact.school.homepage}</p>
      <p>{artifact.greeting}</p>
      <div style={{ padding: '14px 16px', border: '1px solid var(--c-border)', borderRadius: 10 }}>
        <p className="doc-preview-label" style={{ marginBottom: 8 }}>식단표 — S1 표 재사용, 읽기 전용</p>
        {artifact.mealTable.rows.map((row) => <p key={row.date} style={{ padding: '6px 0', fontSize: 14 }}><strong>{row.date.slice(5).replace('-', '/')} {row.weekday}</strong>  {slots.map((slot) => row.menus.find((menu) => menu.slot === slot)?.label).filter(Boolean).join(' · ') || '—'}</p>)}
      </div>
      <p className="subtle" style={{ fontSize: 14 }}>{artifact.allergenNotice}</p>
      <p className="subtle" style={{ fontSize: 13 }}>{artifact.mealTable.legend.map((item) => `${item.no}.${item.name}`).join('  ')}</p>
      <p className="subtle" style={{ fontSize: 14 }}>{artifact.contact}</p>
    </section>
    <section className="document-page-break">
      {artifact.narrativeSlots.map((slot) => <div key={slot.key}>
        <h3>{slot.label}</h3>
        <p style={{ marginTop: 6 }}>{slot.state === 'approved' ? slot.text : slot.state === 'draft' ? <span className="subtle">검토 중인 초안 — 승인 전에는 문서에 반영되지 않습니다.</span> : <span className="subtle">문구 미작성 — 아래 편집 영역에서 작성·검토 후 승인해 주세요.</span>}</p>
        {slot.state === 'approved' && <p className="narrative-meta">{sourceLabel(slot.source)}{slot.simulated ? ' · 모의(Mock) 결과' : ''}{slot.sourceMissing ? ' · 출처 없음' : ''}</p>}
        {slot.state === 'approved' && slot.citations.length > 0 && <ul className="citations">{slot.citations.map((citation) => <li key={citation.url}>{citation.title || citation.url}</li>)}</ul>}
      </div>)}
    </section>
  </>
}

function sourceLabel(source: string) { return ({ router: 'Router 초안', liner: 'Liner 초안', manual: '직접 입력', template: '기본 문구' } as Record<string, string>)[source] ?? source }

function S4Preview({ artifact }: { artifact: S4Document }) {
  return <><p><strong>{artifact.recipient}</strong></p><p>대상 알레르기: {artifact.allergens.map((item) => `${item.no}. ${item.name}`).join(', ')}</p><p>{artifact.confirmationText}</p><table><thead><tr><th>날짜</th><th>기존 메뉴</th><th>확정 대체 메뉴</th><th>충돌 번호</th></tr></thead><tbody>{artifact.rows.map((row, index) => <tr key={`${row.date}-${index}`}><td>{row.date}</td><td>{row.originalMenu}</td><td>{row.substituteMenu}</td><td>{row.allergenNos.join('.')}</td></tr>)}</tbody></table></>
}

