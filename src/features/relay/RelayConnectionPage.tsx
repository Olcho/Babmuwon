import { useState } from 'react'
import { Button, Field, Notice } from '../../ui'
import { s2StateSync } from './s2StateSync'
import { RelayApiError, relayClient, type RelayCatalog, type RelayHealth } from './relayClient'

type TestState = 'idle' | 'testing' | 'connected' | 'error'

/** Relay 연결 패널(SC-08). 토큰은 현재 탭 메모리에만 두고 저장하지 않는다. 연결 성공 시 S2 승인 상태를 다시 동기화한다. */
export function RelayConnectionPage({ onConnected }: { onConnected?: () => void }) {
  const [baseUrl, setBaseUrl] = useState(relayClient.getBaseUrl())
  const [token, setToken] = useState('')
  const [state, setState] = useState<TestState>(relayClient.hasToken() ? 'connected' : 'idle')
  const [health, setHealth] = useState<RelayHealth>()
  const [catalog, setCatalog] = useState<RelayCatalog>()
  const [message, setMessage] = useState('')

  async function testConnection() {
    setState('testing'); setMessage(''); setHealth(undefined); setCatalog(undefined)
    try {
      relayClient.configure(baseUrl, token)
      const healthResult = await relayClient.health()
      setHealth(healthResult)
      try {
        setCatalog(await relayClient.catalog())
        setState('connected')
        // 재연결 후에는 기존에 동기화됐던 S2도 로컬 최신 상태로 다시 검증·보고한다.
        const outcomes = await s2StateSync.syncAll({ force: true })
        const failed = outcomes.filter((item) => item.status === 'failed')
        const synced = outcomes.filter((item) => item.status === 'synced').length
        setMessage(`Relay에 연결했습니다. S2 재동기화: 성공 ${synced}건, 실패 ${failed.length}건.${failed.map((item) => ` [${item.month}] ${item.message}`).join('')}`)
        onConnected?.()
      } catch (error) { setState('error'); setMessage(formatError(error, true)) }
    } catch (error) { setState('error'); setMessage(formatError(error, false)) }
  }

  function clearToken() {
    relayClient.clearToken(); setToken(''); setCatalog(undefined); setState('idle')
    setMessage('메모리에 보관된 Relay 토큰을 지웠습니다.')
  }

  return <section className="ds-card stack" style={{ gap: 20 }}>
    <div className="row row--between"><h3>Relay 연결</h3>
      {state === 'connected' ? <span className="ds-badge ds-badge--success">연결됨{health ? ` · Liner ${health.linerMode}` : ''}</span> : <span className="ds-badge ds-badge--neutral">미연결</span>}</div>
    <p className="subtle" style={{ fontSize: 14 }}>Liner·채널톡 API 키는 Relay(.env)에만 있고 이 화면에서 입력하지 않습니다. 여기에는 로컬 Relay 접속 토큰만 입력합니다.</p>
    <div className="relay-form">
      <Field label="Relay 서버 주소"><input value={baseUrl} inputMode="url" spellCheck={false} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://127.0.0.1:3000" /></Field>
      <Field label="로컬 Relay 토큰" hint="현재 탭 메모리에만 보관 · IndexedDB·localStorage·백업에 저장하지 않음"><input value={token} type="password" autoComplete="off" spellCheck={false} onChange={(event) => setToken(event.target.value)} placeholder={relayClient.hasToken() ? '메모리에 토큰이 설정되어 있습니다' : '토큰 입력'} /></Field>
    </div>
    <div className="row">
      <Button variant="primary" disabled={state === 'testing'} onClick={() => void testConnection()}>{state === 'testing' ? '연결 확인 중…' : '연결 테스트'}</Button>
      <Button disabled={!relayClient.hasToken() && !token} onClick={clearToken}>토큰 지우기</Button>
    </div>
    {message && <Notice tone={state === 'connected' ? 'success' : state === 'error' ? 'danger' : 'info'}>{message}</Notice>}
    {(health || catalog) && <div className="relay-results">
      {health && <dl><dt>서비스</dt><dd>{health.service}</dd><dt>로컬 전용</dt><dd>{health.localOnly ? '예' : '아니요'}</dd><dt>Liner 모드</dt><dd>{health.linerMode === 'mock' ? 'mock (모의 응답)' : health.linerMode === 'live' ? 'live (실제 Liner — FE에서 차단 중)' : health.linerMode}</dd><dt>채널 모드</dt><dd>{health.channelMode}</dd></dl>}
      {catalog && <dl><dt>영양 주제</dt><dd>{Object.keys(catalog.topics).length}개</dd><dt>템플릿 코드</dt><dd>{catalog.templateCode}</dd></dl>}
    </div>}
  </section>
}

function formatError(error: unknown, healthSucceeded: boolean): string {
  if (!(error instanceof RelayApiError)) return 'Relay 연결 중 알 수 없는 오류가 발생했습니다.'
  if (error.kind === 'network_or_cors' && healthSucceeded) return 'health는 성공했지만 인증 요청이 브라우저에서 차단되었습니다. Relay CORS Origin 설정과 Authorization 허용 여부를 확인해 주세요.'
  return `${error.message}${error.code ? ` (${error.code})` : ''}`
}
