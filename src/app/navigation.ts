import { useEffect, useState } from 'react'

/** 화면 목록. 순서는 Figma 상단 내비게이션을 따르고, 디자인에 없지만 기존에 있던 화면은 뒤에 둔다. */
export const SCREENS = [
  { id: 'home', label: '홈' },
  { id: 'school', label: '학교 설정' },
  { id: 'students', label: '학생 알레르기' },
  { id: 'meals', label: '식단 불러오기' },
  { id: 'settings', label: '설정·호출 기록' },
  { id: 'documents', label: '문서 만들기' },
  { id: 'substitutions', label: '대체식 관리' },
  { id: 'sending', label: '학부모 발송' },
] as const

/** 내비게이션에는 없지만 화면 안의 링크로 들어가는 보조 화면. */
export const SUB_SCREENS = [{ id: 'conflicts', label: '알레르기 충돌 탐지', parent: 'substitutions' }] as const

export type ScreenId = (typeof SCREENS)[number]['id'] | (typeof SUB_SCREENS)[number]['id']

const ALL_IDS: readonly string[] = [...SCREENS.map((item) => item.id), ...SUB_SCREENS.map((item) => item.id)]

function readHash(): ScreenId {
  const id = window.location.hash.replace(/^#\/?/, '')
  return (ALL_IDS.includes(id) ? id : 'home') as ScreenId
}

/** 해시(#/students) 기반 화면 전환. 새로고침해도 현재 화면이 유지되고 라이브러리를 추가하지 않는다. */
export function useScreen(): [ScreenId, (id: ScreenId) => void] {
  const [screen, setScreen] = useState<ScreenId>(readHash)
  useEffect(() => {
    const onChange = () => { setScreen(readHash()); window.scrollTo(0, 0) }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return [screen, (id) => { window.location.hash = `/${id}` }]
}

export function navigate(id: ScreenId): void { window.location.hash = `/${id}` }
