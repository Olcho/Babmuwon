import { useEffect, useState, type ReactNode } from 'react'
import logoBowl from '../assets/figma/logo-bowl.svg'
import { db } from '../data'
import { SCREENS, SUB_SCREENS, type ScreenId } from './navigation'

const TODAY = `${new Date().getFullYear()}년 ${new Date().getMonth() + 1}월`

/** 공통 레이아웃: 상단 헤더(로고·학교명·월·역할) + 화면 내비게이션 (Figma 공통 상단 영역). */
export function AppShell({ screen, onNavigate, children }: { screen: ScreenId; onNavigate: (id: ScreenId) => void; children: ReactNode }) {
  const [schoolName, setSchoolName] = useState<string>()
  // 학교 설정이 바뀌면 화면 이동 시 다시 읽는다(IndexedDB는 외부 저장소).
  useEffect(() => { void db.schools.get('school').then((school) => setSchoolName(school?.name)) }, [screen])
  const activeId = SUB_SCREENS.find((item) => item.id === screen)?.parent ?? screen

  return <div className="app">
    <header className="app-header">
      <button type="button" className="app-logo" onClick={() => onNavigate('home')} aria-label="밥무원 홈">
        <span className="app-logo__mark"><img src={logoBowl} alt="" width={24} height={12} /></span>
        <span>밥무원</span>
      </button>
      <div className="app-header__meta">
        <strong>{schoolName || '학교 미설정'}</strong>
        <span>{TODAY}</span>
        <span className="app-role">영양교사</span>
      </div>
    </header>
    <nav className="app-nav" aria-label="업무 화면">
      {SCREENS.map((item) => <button key={item.id} type="button" className={activeId === item.id ? 'is-active' : ''} aria-current={activeId === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}>{item.label}</button>)}
    </nav>
    <main className="app-main">{children}</main>
  </div>
}
