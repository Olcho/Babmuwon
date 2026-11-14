import { useState } from 'react'
import { s2StateSync } from './s2StateSync'
import { RelayApiError, relayClient, type RelayCatalog, type RelayHealth } from './relayClient'

type TestState = 'idle' | 'testing' | 'connected' | 'error'

export function RelayConnectionPage() {
  const [baseUrl, setBaseUrl] = useState(relayClient.getBaseUrl())
  const [token, setToken] = useState('')
  const [state, setState] = useState<TestState>('idle')
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
        const catalogResult = await relayClient.catalog()
        setCatalog(catalogResult)
        setState('connected')
        // 재연결 후에는 기존에 동기화됐던 S2도 로컬 최신 상태로 다시 검증·보고한다.
        const outcomes = await s2StateSync.syncAll({ force: true })
        const failed = outcomes.filter((item) => item.status === 'failed')
        const synced = outcomes.filter((item) => item.status === 'synced').length
        setMessage(`Relay health와 인증된 catalog 요청이 모두 성공했습니다. S2 재동기화: 성공 ${synced}건, 실패 ${failed.length}건.${failed.map((item) => ` [${item.month}] ${item.message}`).join('')}`)
      } catch (error) {
        setState('error')
        setMessage(formatError(error, true))
      }
    } catch (error) {
      setState('error')
      setMessage(formatError(error, false))
    }
  }

  function clearToken() {
    relayClient.clearToken(); setToken(''); setCatalog(undefined); setState('idle')
    setMessage('메모리에 보관된 Relay 토큰을 지웠습니다.')
  }

  return <main className="page-shell relay-page">
    <header className="page-header"><div><p className="eyebrow">Relay</p><h1>Relay 기본 연결</h1><p>health와 catalog를 확인하고, S2 승인 상태(월·버전 번호·승인 여부)만 동기화합니다. 학생·식단·문서 내용은 전송하지 않습니다.</p></div></header>
    <section className="relay-connection-card">
      <label>Relay 서버 주소<input value={baseUrl} inputMode="url" spellCheck={false} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://127.0.0.1:3000" /></label>
      <label>로컬 Relay 토큰<input value={token} type="password" autoComplete="off" spellCheck={false} onChange={(event) => setToken(event.target.value)} placeholder={relayClient.hasToken() ? '메모리에 토큰이 설정되어 있습니다' : '토큰 입력'} /></label>
      <p className="safety-notice">토큰은 현재 탭의 메모리에만 보관되며 IndexedDB, localStorage, 코드 또는 백업 파일에 저장되지 않습니다.</p>
      <div className="relay-actions"><button className="primary" disabled={state === 'testing'} onClick={() => void testConnection()}>{state === 'testing' ? '연결 확인 중…' : 'health + catalog 연결 테스트'}</button><button disabled={!relayClient.hasToken() && !token} onClick={clearToken}>토큰 지우기</button></div>
    </section>
    {message && <p className={state === 'connected' ? 'notice' : state === 'error' ? 'warning' : 'notice'} role="status">{message}</p>}
    <section className="relay-results" aria-live="polite">
      <article><h2>/health</h2>{health ? <dl><dt>서비스</dt><dd>{health.service}</dd><dt>로컬 전용</dt><dd>{health.localOnly ? '예' : '아니요'}</dd><dt>Liner 모드</dt><dd>{health.linerMode}</dd><dt>채널 모드</dt><dd>{health.channelMode}</dd></dl> : <p>아직 확인하지 않았습니다.</p>}</article>
      <article><h2>/catalog</h2>{catalog ? <dl><dt>후보 음식</dt><dd>{catalog.foods.length}개</dd><dt>영양 주제</dt><dd>{Object.keys(catalog.topics).length}개</dd><dt>템플릿 코드</dt><dd>{catalog.templateCode}</dd></dl> : <p>인증된 catalog를 아직 확인하지 않았습니다.</p>}</article>
    </section>
  </main>
}

function formatError(error: unknown, healthSucceeded: boolean): string {
  if (!(error instanceof RelayApiError)) return 'Relay 연결 중 알 수 없는 오류가 발생했습니다.'
  if (error.kind === 'network_or_cors' && healthSucceeded) {
    return 'health는 성공했지만 인증 요청이 브라우저에서 차단되었습니다. Relay CORS Origin 설정과 Authorization 허용 여부를 확인해 주세요.'
  }
  const detail = error.code ? ` (${error.code})` : ''
  return `${error.message}${detail}`
}
