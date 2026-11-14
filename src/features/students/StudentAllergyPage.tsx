import { useEffect, useMemo, useState, type FormEvent } from 'react'
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

export function StudentAllergyPage() {
  const [records, setRecords] = useState<StudentRecord[]>([])
  const [form, setForm] = useState<FormState>(emptyForm)
  const [editingId, setEditingId] = useState<string>()
  const [search, setSearch] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

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
    window.scrollTo({ top: 0, behavior: 'smooth' })
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
      if (editingId === record.student.id) { setEditingId(undefined); setForm(emptyForm()) }
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
      allergenNos: current.allergenNos.includes(no)
        ? current.allergenNos.filter((item) => item !== no)
        : [...current.allergenNos, no].sort((a, b) => a - b),
    }))
  }

  return (
    <main className="page-shell student-page">
      <header className="page-header">
        <div><p className="eyebrow">SC-03</p><h1>학생 알레르기 등록</h1><p>학생 정보와 가명은 이 기기의 IndexedDB에만 저장되며 외부로 전송되지 않습니다.</p></div>
      </header>
      {message && <p className="notice" role="status">{message}</p>}
      {error && <p className="error-panel" role="alert">{error}</p>}

      <section className="student-form-card">
        <div className="section-heading"><div><h2>{editingId ? '학생 정보 수정' : '학생 등록'}</h2><p>가명은 저장할 때 자동으로 만들어지며 직접 입력할 수 없습니다.</p></div></div>
        <form onSubmit={submit}>
          <div className="student-fields">
            <label>학년<input type="number" min="1" max="6" required value={form.grade} onChange={(event) => setForm({ ...form, grade: event.target.value })} /></label>
            <label>반<input type="number" min="1" max="99" required value={form.classNumber} onChange={(event) => setForm({ ...form, classNumber: event.target.value })} /></label>
            <label>번호<input type="number" min="1" max="99" required value={form.number} onChange={(event) => setForm({ ...form, number: event.target.value })} /></label>
            <label>실명 <small>선택·기본 숨김</small><input type="text" maxLength={50} value={form.realName} onChange={(event) => setForm({ ...form, realName: event.target.value })} /></label>
          </div>

          <fieldset className="allergen-fieldset">
            <legend>알레르기 유발식품 <span>1개 이상 선택</span></legend>
            <div className="allergen-options">{ALLERGEN_ITEMS.map((item) => (
              <label key={item.no} className={form.allergenNos.includes(item.no) ? 'selected' : ''}>
                <input type="checkbox" checked={form.allergenNos.includes(item.no)} onChange={() => toggleAllergen(item.no)} />
                <strong>{item.no}</strong> {item.name}{item.includes.length > 0 && <small>{item.includes.join('·')} 포함</small>}
              </label>
            ))}</div>
          </fieldset>

          <div className="student-fields lower-fields">
            <label>대체식 필요<select value={form.needsSubstitute ? 'yes' : 'no'} onChange={(event) => setForm({ ...form, needsSubstitute: event.target.value === 'yes' })}><option value="yes">예</option><option value="no">아니오</option></select></label>
            <label className="memo-field">메모 <small>문서·외부 전송 제외</small><input type="text" maxLength={200} value={form.memo} onChange={(event) => setForm({ ...form, memo: event.target.value })} /></label>
          </div>
          <div className="form-actions">
            {editingId && <button type="button" onClick={() => { setEditingId(undefined); setForm(emptyForm()); setError('') }}>취소</button>}
            <button type="submit" className="primary" disabled={busy}>{editingId ? '수정 저장' : '학생 등록'}</button>
          </div>
        </form>
      </section>

      <section className="student-list-card">
        <div className="section-heading">
          <div><h2>학생 목록 <span className="count-badge">{records.length}</span></h2><p>실명은 목록에 표시하지 않습니다.</p></div>
          <input className="student-search" type="search" placeholder="학년·반·번호, 가명, 알레르기 검색" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        {filtered.length === 0 ? <div className="empty-list">{records.length === 0 ? '등록된 학생이 없습니다.' : '검색 결과가 없습니다.'}</div> : (
          <div className="table-scroll"><table className="student-table"><thead><tr><th>학년·반·번호</th><th>가명</th><th>알레르기</th><th>대체식</th><th>메모</th><th>관리</th></tr></thead><tbody>
            {filtered.map((record) => <tr key={record.student.id}>
              <td>{record.student.grade}학년 {record.student.class}반 {record.student.number}번</td>
              <td><strong>{record.student.alias}</strong></td>
              <td>{record.allergenNos.map((no) => `${no}. ${ALLERGEN_ITEMS.find((item) => item.no === no)?.name}`).join(', ')}</td>
              <td>{record.student.needsSubstitute ? '필요' : '제외만'}</td>
              <td>{record.student.memo || '—'}</td>
              <td><div className="row-actions"><button type="button" onClick={() => startEdit(record)}>수정</button><button type="button" disabled={busy} onClick={() => void regenerateAlias(record.student.id)}>가명 다시 생성</button><button type="button" className="danger" disabled={busy} onClick={() => void remove(record)}>삭제</button></div></td>
            </tr>)}
          </tbody></table></div>
        )}
      </section>
    </main>
  )
}
