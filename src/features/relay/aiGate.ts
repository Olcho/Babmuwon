import type { BabmuwonDatabase } from '../../data'
import { ALLOW_LIVE_LINER } from './aiPrivacyGuard'
import type { RelayHealth } from './relayClient'

/** 서버 측 개인정보 차단이 검증되지 않아 live Liner로는 요청하지 않는다. */
export class LinerModeBlockedError extends Error {
  constructor(message: string) { super(message); this.name = 'LinerModeBlockedError' }
}

/** AI 요청 직전에 Relay의 Liner 모드를 확인한다. mock이 아니면(ALLOW_LIVE_LINER 해제 전) 요청하지 않는다. */
export async function assertMockLiner(client: { health(): Promise<RelayHealth> }): Promise<void> {
  const health = await client.health()
  if (health.linerMode === 'mock') return
  if (health.linerMode === 'live' && ALLOW_LIVE_LINER) return
  throw new LinerModeBlockedError(health.linerMode === 'live'
    ? 'Relay가 실제 Liner(live) 모드입니다. 서버 측 개인정보 차단이 검증되기 전에는 AI 요청을 보내지 않습니다. Mock 모드에서만 사용할 수 있습니다.'
    : 'Relay의 Liner가 비활성화되어 있습니다.')
}

/** 허용 필드 값과 상태만 기록한다. 차단된 요청은 값 없이 기록한다(명세 E6, 9-1). */
export async function logAiCall(
  database: BabmuwonDatabase, endpoint: string, allowedFields: Record<string, unknown>, status: 'ok' | 'blocked' | 'error' | 'cached',
): Promise<void> {
  await database.apiCallLogs.add({ id: crypto.randomUUID(), at: new Date().toISOString(), endpoint, allowedFields, status })
}
