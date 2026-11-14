import { useEffect, useState, type FormEvent } from 'react'
import { SchoolRepository, db } from '../../data'
import { Button, Field, Notice, PageHeader } from '../../ui'

const repository = new SchoolRepository(db)

interface SchoolForm { name: string; principal: string; manager: string; phone: string; headcount: string; motto: string; address: string; homepage: string }
const EMPTY: SchoolForm = { name: '', principal: '', manager: '', phone: '', headcount: '', motto: '', address: '', homepage: '' }

/** SC-02 학교 설정 (Figma Frame 2). 저장은 기존 SchoolRepository를 쓴다(저장 시 승인된 S2는 재검토 대상으로 바뀐다). */
export function SchoolSettingsPage() {
  const [form, setForm] = useState<SchoolForm>(EMPTY)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void repository.get().then((school) => {
      if (school) setForm({
        name: school.name, principal: school.principal, manager: school.manager, phone: school.phone, headcount: String(school.headcount),
        motto: school.motto ?? '', address: school.address ?? '', homepage: school.homepage ?? '',
      })
    })
  }, [])

  const set = (key: keyof SchoolForm) => (value: string) => setForm((current) => ({ ...current, [key]: value }))

  async function save(event: FormEvent) {
    event.preventDefault()
    setMessage(''); setError('')
    const headcount = form.headcount.replace(/[^\d]/g, '')
    if (!form.name.trim()) { setError('학교명을 입력해 주세요.'); return }
    if (form.headcount.trim() && !/^\d+\s*명?$/.test(form.headcount.trim())) { setError('급식 인원은 0 이상의 정수로 입력해 주세요.'); return }
    setSaving(true)
    try {
      await repository.save({
        name: form.name.trim(), principal: form.principal.trim(), manager: form.manager.trim(), phone: form.phone.trim(),
        headcount: headcount ? Number(headcount) : 0,
        motto: form.motto.trim() || undefined, address: form.address.trim() || undefined, homepage: form.homepage.trim() || undefined,
      })
      setMessage('학교 정보를 저장했습니다. 이미 승인된 가정통신문(S2)은 재검토 대상으로 바뀝니다.')
    } catch (caught) { setError(caught instanceof Error ? caught.message : '저장하지 못했습니다.') }
    finally { setSaving(false) }
  }

  return <>
    <div className="page"><PageHeader title="학교 설정" /></div>
    <section className="school-band">
      <div className="page" style={{ paddingTop: 0 }}>
        <div className="school-layout">
          <aside className="school-aside">
            <h2>학교 정보</h2>
            <div className="info-box"><span className="info-box__icon">i</span><p>학교명은 문서 머리말에만 들어갑니다. 외부 AI로는 보내지 않으며, 요청에 학교명이 섞이면 전송을 차단합니다.</p></div>
          </aside>
          <form className="school-form" onSubmit={(event) => void save(event)}>
            {message && <div style={{ width: '100%' }}><Notice tone="success">{message}</Notice></div>}
            {error && <div style={{ width: '100%' }}><Notice tone="danger">{error}</Notice></div>}
            <div className="school-grid">
              <Field label="학교명 *" className="span-2"><input value={form.name} onChange={(event) => set('name')(event.target.value)} required maxLength={50} placeholder="예) 데모중학교" /></Field>
              <Field label="학교장"><input value={form.principal} onChange={(event) => set('principal')(event.target.value)} maxLength={30} /></Field>
              <Field label="급식 담당"><input value={form.manager} onChange={(event) => set('manager')(event.target.value)} maxLength={30} /></Field>
              <Field label="연락처"><input value={form.phone} onChange={(event) => set('phone')(event.target.value)} maxLength={30} placeholder="031-000-0000" /></Field>
              <Field label="급식 인원"><input value={form.headcount} onChange={(event) => set('headcount')(event.target.value)} inputMode="numeric" placeholder="612명" /></Field>
              <Field label="교훈 (가정통신문 머리말)"><input value={form.motto} onChange={(event) => set('motto')(event.target.value)} maxLength={60} /></Field>
              <Field label="홈페이지 (가정통신문 머리말)"><input value={form.homepage} onChange={(event) => set('homepage')(event.target.value)} maxLength={120} /></Field>
              <Field label="주소 (가정통신문 머리말)" className="span-2"><input value={form.address} onChange={(event) => set('address')(event.target.value)} maxLength={120} /></Field>
            </div>
            <Button type="submit" variant="primary" disabled={saving}>{saving ? '저장 중…' : '저장'}</Button>
          </form>
        </div>
      </div>
    </section>
  </>
}
