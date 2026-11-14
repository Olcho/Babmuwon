import { useEffect, useState, type CSSProperties } from 'react'
import chevron from '../../assets/figma/chevron.svg'
import checklist from '../../assets/figma/hero-checklist.svg'
import hands from '../../assets/figma/hero-hands.svg'
import leaf from '../../assets/figma/hero-leaf.svg'
import leftArm from '../../assets/figma/hero-left-arm.svg'
import tray from '../../assets/figma/hero-lunch-tray.svg'
import orange from '../../assets/figma/hero-orange.svg'
import rightArm from '../../assets/figma/hero-right-arm.svg'
import iconDoc from '../../assets/figma/icon-doc.svg'
import iconPeople from '../../assets/figma/icon-people.svg'
import iconSchool from '../../assets/figma/icon-school.svg'
import iconSend from '../../assets/figma/icon-send.svg'
import { navigate, type ScreenId } from '../../app/navigation'
import { Button, SectionTitle } from '../../ui'
import { loadHomeSummary, type HomeSummary } from './homeSummary'

/** SC-01 홈 (Figma Frame 1). */
export function HomePage() {
  const [summary, setSummary] = useState<HomeSummary>()
  useEffect(() => { void loadHomeSummary().then(setSummary) }, [])

  const plan = summary?.plan
  const subs = summary?.substitutions
  const docs = summary?.documents
  const sending = summary?.sending
  const planDone = plan?.status === 'confirmed'
  const substitutionsDone = Boolean(planDone && subs && subs.open === 0 && subs.unknownMenu === 0)

  return <>
    <section className="home-hero">
      <div className="home-hero__inner">
        <div className="home-hero__copy">
          <p className="home-hero__eyebrow">HEALTHY MEALS, SIMPLE WORK</p>
          <h1>건강한 한 끼,<br />가벼워지는 급식 업무</h1>
          <p>식단부터 대체식, 문서와 안내까지.<br />이번 달 급식 준비를 한곳에서 이어가세요.</p>
          <Button variant="hero" className="home-hero__cta" onClick={() => navigate('meals')}>식단 엑셀 올리기  ↗</Button>
        </div>
        <HeroIllustration />
      </div>
    </section>

    <div className="page" style={{ paddingTop: 0 }}>
      <div className="home-grid">
        <section>
          <SectionTitle>이번 달 진행 상황{summary?.month ? ` · ${summary.month}` : ''}</SectionTitle>
          <div className="home-status">
            <StatusCard target="meals" title="식단" tag={planDone ? '✓ 완료' : plan ? '확정 필요' : '업로드 필요'}
              value={!plan ? '미업로드' : planDone ? '확정됨' : '작성 중'} tone={planDone ? 'done' : plan ? 'alert' : 'idle'}
              extra={plan && plan.unknownCount > 0 ? `미확인 메뉴 ${plan.unknownCount}개` : undefined} />
            <StatusCard target="documents" title="문서" tag={docs?.stale ? '재검토 필요' : docs?.generated === 5 ? '✓ 생성됨' : '작성 대기'}
              value={`${docs?.generated ?? 0} / 5 생성`} tone={docs?.stale ? 'alert' : docs?.generated === 5 ? 'done' : 'idle'}
              extra={docs?.stale ? `재검토 ${docs.stale}건` : undefined} />
            <StatusCard target="substitutions" title="대체식" tag={substitutionsDone ? '✓ 완료' : subs?.open || subs?.unknownMenu ? '확인 필요' : '대기'}
              value={!planDone ? '식단 확정 후' : subs?.open || subs?.unknownMenu ? `미확정 ${(subs?.open ?? 0) + (subs?.unknownMenu ?? 0)}건` : `${subs?.total ?? 0}건 처리`}
              tone={subs?.open || subs?.unknownMenu ? 'alert' : substitutionsDone ? 'done' : 'idle'}
              extra={subs?.needsReview ? `재검토 ${subs.needsReview}건` : undefined} />
            <StatusCard target="sending" title="학부모 발송" tag={sending?.correctionNeeded ? '정정 안내 필요' : sending?.batches ? 'Mock 완료' : '발송 대기'}
              value={sending?.batches ? `Mock ${sending.requested}건` : '미발송'} tone={sending?.correctionNeeded ? 'alert' : sending?.batches ? 'done' : 'idle'} />
          </div>
        </section>

        <section>
          <SectionTitle>바로가기</SectionTitle>
          <div className="home-shortcuts">
            <Shortcut icon={iconSchool} label="학교 설정" target="school" />
            <Shortcut icon={iconPeople} label="학생 알레르기" target="students" />
            <Shortcut icon={iconDoc} label="문서 만들기" target="documents" />
            <Shortcut icon={iconSend} label="학부모 발송" target="sending" />
          </div>
        </section>
      </div>

      <section className="home-next">
        <SectionTitle>다음 할 일</SectionTitle>
        <div className="home-next__list">
          {!planDone && <NextCard title="식단 확정" desc={plan ? '확정해야 다음 단계가 열립니다' : '엑셀을 올려 주세요'} target="meals" link="식단 불러오기" />}
          <NextCard title="대체식 확정" desc={!planDone ? '식단 확정 후 가능' : `${(subs?.open ?? 0) + (subs?.unknownMenu ?? 0)}건 남음`} target="substitutions" link="대체식 관리" disabled={!planDone} />
          <NextCard title="문서 만들기" desc={substitutionsDone ? `${docs?.generated ?? 0} / 5 생성` : '대체식 확정 후 가능'} target="documents" link="문서 만들기" disabled={!planDone} />
          <NextCard title="학부모 발송" desc={docs?.s2Approved ? 'S2 승인됨 · 발송 가능' : '가정통신문(S2) 승인 후 가능'} target="sending" link="학부모 발송" disabled={!docs?.s2Approved} />
        </div>
      </section>
    </div>
  </>
}

function StatusCard({ title, tag, value, tone, target, extra }: { title: string; tag: string; value: string; tone: 'done' | 'alert' | 'idle'; target: ScreenId; extra?: string }) {
  return <button type="button" className={`status-card${tone === 'done' ? ' status-card--done' : tone === 'alert' ? ' status-card--alert' : ''}`} onClick={() => navigate(target)}>
    <span className="status-card__top"><strong>{title}</strong><span>{tag}</span></span>
    <span className="status-card__value">{value}</span>
    {extra && <span style={{ fontSize: 13 }}>{extra}</span>}
  </button>
}

function Shortcut({ icon, label, target }: { icon: string; label: string; target: ScreenId }) {
  return <button type="button" className="shortcut" onClick={() => navigate(target)}>
    <img src={icon} alt="" width={32} height={32} />
    <span className="shortcut__row"><span>{label}</span><span aria-hidden="true">↗</span></span>
  </button>
}

function NextCard({ title, desc, target, link, disabled }: { title: string; desc: string; target: ScreenId; link: string; disabled?: boolean }) {
  return <button type="button" className="next-card" disabled={disabled} onClick={() => navigate(target)}>
    <strong>{title}</strong><span>{desc}</span>
    {!disabled && <span className="next-card__link">{link}<img src={chevron} alt="" /></span>}
  </button>
}

/** Figma '급식 일러스트'(446×320) — 레이어 위치·회전을 그대로 옮겼다. */
function HeroIllustration() {
  const at = (inset: string): CSSProperties => ({ inset })
  return <div className="home-illustration" aria-hidden="true">
    <div style={at('53.61% 66.76% 8.75% 6.05%')}><img src={leftArm} alt="" /></div>
    <div style={at('49.5% 5.83% 8.13% 63.51%')}><img src={rightArm} alt="" /></div>
    <div className="rot" style={at('15.9% 15.92% 13.07% 16.76%')}>
      <div style={{ position: 'relative', flex: 'none', transform: 'rotate(-6deg)', width: 'hypot(93.0723cqw, -12.9234cqh)', height: 'hypot(6.92767cqw, 87.0766cqh)' }}>
        <div style={{ position: 'absolute', inset: '-0.38% 0 0 -0.27%' }}><img src={tray} alt="" /></div>
      </div>
    </div>
    <div style={at('54.02% 21.97% 32.37% 19.73%')}><img src={hands} alt="" /></div>
    <div className="rot" style={at('8.53% 76.73% 63.36% 6.21%')}>
      <div style={{ position: 'relative', flex: 'none', transform: 'rotate(-12deg)', width: 'hypot(78.4143cqw, -14.0987cqh)', height: 'hypot(21.5857cqw, 85.9013cqh)' }}><img src={checklist} alt="" /></div>
    </div>
    <div style={at('7.5% 70.95% 81.88% 23.54%')}><div style={{ position: 'absolute', inset: '0 0 -2.94% -4.07%' }}><img src={leaf} alt="" /></div></div>
    <div style={at('37.5% 88.57% 55% 6.05%')}><img src={orange} alt="" /></div>
  </div>
}
