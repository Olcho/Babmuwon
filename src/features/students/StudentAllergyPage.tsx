import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import peopleIcon from '../../assets/figma/icon-people-lg.svg'
import { Button, Field, Notice, PageHeader, SectionTitle, ToggleChip } from '../../ui'
import type { AllergenNo } from '../../data'
import { ALLERGEN_ITEMS } from './allergens'
import { studentService, type StudentInput, type StudentRecord } from './studentService'

interface FormState {
  grade: string
  classNumber: string
  number: string
  realName: string
  needsSubstitute: boolean
  memo: string
  allergenNos: AllergenNo[]
}

const emptyForm = (): FormState => ({
  grade: '', classNumber: '', number: '', realName: '', needsSubstitute: true, memo: '', allergenNos: [],
})

/** SC-03 학생 알레르기 (Figma Frame 37). 등록·수정·삭제·가명 다시 뽑기는 기존 studentService를 쓴다. */
export function StudentAllergyPage() {
  const [records, setRecords] = useState<StudentRecord[]>([])
  const [form, setForm] = useState<FormState>(emptyForm)
  const [editingId, setEditingId] = useState<string>()
  const [search, setSearch] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => { void refresh() }, [])

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('ko-KR')
    if (!query) return records
    return records.filter(({ student, allergenNos }) => [
      `${student.grade}학년 ${student.class}반 ${student.number}번`, student.alias, student.realName ?? '',
      ...allergenNos.map((no) => ALLERGEN_ITEMS.find((item) => item.no === no)?.name ?? ''),
    ].some((value) => value.toLocaleLowerCase('ko-KR').includes(query)))
  }, [records, search])

  async function refresh() {
    setRecords(await studentService.getAll())
  }

  function toInput(): StudentInput {
    return {
      grade: Number(form.grade),
      class: Number(form.classNumber),
      number: Number(form.number),
      realName: form.realName,
      needsSubstitute: form.needsSubstitute,
      memo: form.memo,
      allergenNos: form.allergenNos,
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      if (editingId) {
        await studentService.update(editingId, toInput())
        setMessage('학생 정보를 수정했습니다. 관련 문서는 재검토 대상으로 변경됩니다.')
      } else {
        await studentService.create(toInput())
        setMessage('가상 학생을 이 기기에 등록했습니다.')
      }
      setEditingId(undefined)
      setForm(emptyForm())
      setFormOpen(false)
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '학생 정보를 저장하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  function startEdit(record: StudentRecord) {
    const { student, allergenNos } = record
    setEditingId(student.id)
    setForm({
      grade: String(student.grade), classNumber: String(student.class), number: String(student.number),
      realName: student.realName ?? '', needsSubstitute: student.needsSubstitute, memo: student.memo,
      allergenNos: [...allergenNos],
    })
    setError('')
    setMessage('')
    setFormOpen(true)
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  function startCreate() {
    setEditingId(undefined)
    setForm(emptyForm())
    setError('')
    setMessage('')
    setFormOpen(true)
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  async function regenerateAlias(id: string) {
    setBusy(true)
    setError('')
    try {
      await studentService.regenerateAlias(id)
      setMessage('가명을 새로 만들었습니다. 이전 가명은 다시 사용되지 않습니다.')
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '가명을 변경하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(record: StudentRecord) {
    const label = `${record.student.grade}학년 ${record.student.class}반 ${record.student.number}번 (${record.student.alias})`
    if (!window.confirm(`${label} 학생을 삭제할까요? 삭제된 가명은 다시 사용하지 않습니다.`)) return
    setBusy(true)
    setError('')
    try {
      await studentService.delete(record.student.id)
      if (editingId === record.student.id) { setEditingId(undefined); setForm(emptyForm()); setFormOpen(false) }
      setMessage('학생 정보를 삭제했습니다. 관련 문서는 재검토 대상으로 변경됩니다.')
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '학생 정보를 삭제하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  function toggleAllergen(no: AllergenNo) {
    setForm((current) => ({
      ...current,
      allergenNos: current.allergenNos.includes(no) ? current.allergenNos.filter((item) => item !== no) : [...current.allergenNos, no].sort((a, b) => a - b),
    }))
  }

  const editing = records.find((record) => record.student.id === editingId)

  return <div className="page stack">
    <PageHeader title="학생 알레르기" actions={<Button size="lg" variant="primary" onClick={startCreate}>학생 추가</Button>} />

    <div className="summary-bar">
      <img src={peopleIcon} alt="" width={42} height={42} />
      <strong>{records.length}명 등록</strong>
      <p>학년·반·번호와 가명으로 학생을 확인합니다. 실명은 선택 입력이며 목록에 표시하지 않습니다. 이 정보는 이 기기에만 저장됩니다.</p>
    </div>
    {message && <Notice tone="success">{message}</Notice>}
    {error && <Notice tone="danger">{error}</Notice>}

    <section className="stack" style={{ gap: 16 }}>
      <SectionTitle actions={<input className="student-search" type="search" placeholder="학년·반·번호, 가명, 알레르기 검색" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="학생 검색" />}>학생 목록</SectionTitle>
      {filtered.length === 0 ? <div className="empty"><strong>{records.length === 0 ? '등록된 학생이 없습니다' : '검색 결과가 없습니다'}</strong>{records.length === 0 && '‘학생 추가’로 가명 학생을 등록해 주세요.'}</div> : (
        <div className="ds-table-wrap"><table className="ds-table"><thead><tr><th style={{ width: '46%' }}>학생</th><th style={{ width: '30%' }}>알레르기 번호</th><th>대체식</th><th className="sr-only">관리</th></tr></thead><tbody>
          {filtered.map((record) => <tr key={record.student.id} className={`is-clickable${editingId === record.student.id ? ' is-selected' : ''}`} onClick={() => startEdit(record)}>
            <td>{record.student.grade}-{record.student.class}-{record.student.number} · {record.student.alias}</td>
            <td title={record.allergenNos.map((no) => `${no}. ${ALLERGEN_ITEMS.find((item) => item.no === no)?.name}`).join(', ')}>{record.allergenNos.join('.')}</td>
            <td>{record.student.needsSubstitute ? '필요' : '제외만'}</td>
            <td><div className="cell-actions"><Button size="sm" onClick={(event) => { event.stopPropagation(); startEdit(record) }}>수정</Button></div></td>
          </tr>)}
        </tbody></table></div>
      )}
    </section>

    {formOpen && <form ref={formRef} className="ds-card student-form" onSubmit={(event) => void submit(event)}>
      <h3>{editing ? `학생 정보 수정 · ${editing.student.alias}` : '학생 정보 입력'}</h3>
      <div className="student-form__top">
        <Field label="학년-반-번호">
          <span className="grade-inputs">
            <input aria-label="학년" inputMode="numeric" value={form.grade} onChange={(event) => setForm({ ...form, grade: event.target.value })} placeholder="1" required />
            <span>-</span>
            <input aria-label="반" inputMode="numeric" value={form.classNumber} onChange={(event) => setForm({ ...form, classNumber: event.target.value })} placeholder="2" required />
            <span>-</span>
            <input aria-label="번호" inputMode="numeric" value={form.number} onChange={(event) => setForm({ ...form, number: event.target.value })} placeholder="5" required />
          </span>
        </Field>
        <div className="ds-field">
          <span className="ds-field__label">가명</span>
          <div className="alias-row">
            <output>{editing ? `${editing.student.alias} (자동 배정 · 수정 불가)` : '저장하면 자동 배정됩니다 (수정 불가)'}</output>
            <Button disabled={!editing || busy} onClick={() => editing && void regenerateAlias(editing.student.id)}>다시 뽑기</Button>
          </div>
        </div>
        <Field label="실명 (선택)"><input value={form.realName} maxLength={50} autoComplete="off" onChange={(event) => setForm({ ...form, realName: event.target.value })} placeholder="입력 안 함 · 기본 숨김" /></Field>
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <span className="ds-field__label" style={{ fontSize: 18 }}>알레르기 번호 (복수 선택)</span>
        <div className="chip-row">{ALLERGEN_ITEMS.map((item) => <ToggleChip key={item.no} selected={form.allergenNos.includes(item.no)} title={item.name} onClick={() => toggleAllergen(item.no)}>{item.no}</ToggleChip>)}</div>
        <p className="subtle" style={{ fontSize: 14 }}>{form.allergenNos.length ? form.allergenNos.map((no) => `${no}. ${ALLERGEN_ITEMS.find((item) => item.no === no)?.name}`).join(', ') : '1개 이상 선택해 주세요.'}</p>
      </div>
      <Field label="메모 (문서에 나가지 않음)"><input value={form.memo} maxLength={200} onChange={(event) => setForm({ ...form, memo: event.target.value })} /></Field>
      <div className="student-form__footer">
        <label className="check"><input type="checkbox" checked={form.needsSubstitute} onChange={(event) => setForm({ ...form, needsSubstitute: event.target.checked })} /> 대체식 필요 (해제하면 ‘제외만’)</label>
        <div className="row">
          <Button onClick={() => { setFormOpen(false); setEditingId(undefined); setForm(emptyForm()) }}>취소</Button>
          {editing && <Button variant="danger" disabled={busy} onClick={() => void remove(editing)}>삭제</Button>}
          <Button type="submit" variant="primary" disabled={busy}>{busy ? '저장 중…' : '저장'}</Button>
        </div>
      </div>
    </form>}
  </div>
}
