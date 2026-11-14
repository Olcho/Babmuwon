import { useEffect, useState } from 'react'
import { db, type ApiCallLog } from '../../data'
import { Badge, Button, Notice, PageHeader, SectionTitle } from '../../ui'
import { RelayConnectionPage } from '../relay/RelayConnectionPage'
import { RelayApiError, relayClient, type RelayAuditEvent } from '../relay/relayClient'

/**
 * SC-08 설정·외부 호출 기록. 최종(보라) Figma 디자인이 없어 공통 디자인 요소로 구성했다.
 * FE 기록(apiCallLogs)은 허용 필드 값과 상태만, Relay 기록(/audit)은 시각·엔드포인트·상태 코드만 담는다.
 */
export function SettingsPage() {
  const [logs, setLogs] = useState<ApiCallLog[]>([])
  const [audit, setAudit] = useState<RelayAuditEvent[]>()
  const [auditError, setAuditError] = useState('')

  async function loadLogs() { setLogs((await db.apiCallLogs.toArray()).sort((a, b) => b.at.localeCompare(a.at))) }
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadLogs() }, [])

  async function loadAudit() {
    setAuditError('')
    try { setAudit(await relayClient.audit()) }
    catch (error) { setAudit(undefined); setAuditError(error instanceof RelayApiError ? `${error.message}${error.code ? ` (${error.code})` : ''}` : 'Relay 기록을 불러오지 못했습니다.') }
  }

  return <div className="page stack stack--lg">
    <PageHeader title="설정·외부 호출 기록" />
    <div className="settings-grid">
      <RelayConnectionPage onConnected={() => void loadLogs()} />
      <aside className="ds-card ds-card--tint stack" style={{ gap: 12 }}>
        <h3>개인정보 보호</h3>
        <p style={{ fontSize: 15 }}>외부 AI 요청에는 월·메뉴명·영양 주제·알레르기 번호·3명 미만을 합친 집계만 담깁니다. 학생 실명·가명·학년반·전화번호·학교명이 섞이면 요청을 보내지 않고 차단합니다.</p>
        <p className="subtle" style={{ fontSize: 14 }}>서버 측 개인정보 검사가 검증되기 전까지 실제 Liner(live) 호출은 막혀 있고, Relay가 Mock 모드일 때만 AI 문구를 받습니다.</p>
      </aside>
    </div>

    <section className="stack" style={{ gap: 16 }}>
      <SectionTitle actions={<Button size="sm" onClick={() => void loadLogs()}>새로고침</Button>}>외부 호출 기록 (이 브라우저)</SectionTitle>
      <p className="subtle" style={{ fontSize: 14 }}>외부로 보낸 허용 필드와 처리 결과입니다. 차단된 요청은 값을 기록하지 않습니다.</p>
      {logs.length === 0 ? <div className="empty"><strong>호출 기록이 없습니다</strong>AI 문구 생성이나 근거 검색을 하면 여기에 남습니다.</div>
        : <div className="ds-table-wrap"><table className="ds-table"><thead><tr><th>시간</th><th>API</th><th>보낸 내용(허용 필드)</th><th>결과</th></tr></thead><tbody>
          {logs.map((log) => <tr key={log.id} className={log.status === 'blocked' || log.status === 'error' ? 'log-row--blocked' : 'log-row--ok'}>
            <td>{new Date(log.at).toLocaleString('ko-KR')}</td><td>{apiLabel(log.endpoint)}</td>
            <td style={{ fontSize: 14 }}>{Object.keys(log.allowedFields).length ? summarize(log.allowedFields) : '— (차단·값 미기록)'}</td>
            <td><Badge tone={log.status === 'blocked' || log.status === 'error' ? 'danger' : 'success'}>{statusLabel(log.status)}</Badge></td>
          </tr>)}
        </tbody></table></div>}
    </section>

    <section className="stack" style={{ gap: 16 }}>
      <SectionTitle actions={<Button size="sm" disabled={!relayClient.hasToken()} onClick={() => void loadAudit()}>Relay 기록 불러오기</Button>}>Relay 기록 (/audit)</SectionTitle>
      {auditError && <Notice tone="danger">{auditError}</Notice>}
      {!relayClient.hasToken() && <p className="subtle">Relay에 연결하면 Relay가 남긴 기록(시각·엔드포인트·상태 코드)을 볼 수 있습니다.</p>}
      {audit && (audit.length === 0 ? <div className="empty">Relay 기록이 없습니다.</div>
        : <div className="ds-table-wrap"><table className="ds-table"><thead><tr><th>시각</th><th>엔드포인트</th><th>상태</th><th>HTTP</th><th>소요</th></tr></thead><tbody>
          {audit.map((event, index) => <tr key={`${event.at}-${index}`}><td>{new Date(event.at).toLocaleString('ko-KR')}</td><td>{event.endpoint}</td><td>{event.status}</td><td>{event.statusCode}</td><td>{event.durationMs}ms</td></tr>)}
        </tbody></table></div>)}
    </section>

    <Notice>백업·복원(JSON 내보내기)은 아직 구현되지 않았습니다.</Notice>
  </div>
}

function apiLabel(endpoint: string) {
  return ({ '/ai/s2-news': 'Router · S2 소식', '/ai/nutrition': 'Search · 영양 정보', '/ai/substitute-evidence': 'Search · 대체식 근거', '/ai/s5-body': 'Router · S5 본문' } as Record<string, string>)[endpoint] ?? endpoint
}
function statusLabel(status: ApiCallLog['status']) { return { ok: '성공', cached: '캐시', blocked: '차단', error: '오류' }[status] }
function summarize(fields: Record<string, unknown>): string {
  return Object.entries(fields).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value).slice(0, 160) : String(value)}`).join(' · ')
}
