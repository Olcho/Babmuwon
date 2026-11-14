import { ConflictRepository, db, StudentRepository, type AllergenNo, type BabmuwonDatabase, type Student } from '../../data'
import { ALLERGEN_ITEMS } from './allergens'

const ALIAS_WORDS = ['구름', '물결', '별빛', '노을', '하늘', '바람', '여울', '새벽', '윤슬', '마루', '나래', '한결', '다온', '푸름', '해솔', '단비'] as const

export interface StudentInput {
  grade: number
  class: number
  number: number
  realName?: string
  needsSubstitute: boolean
  memo: string
  allergenNos: AllergenNo[]
}

export interface StudentRecord {
  student: Student
  allergenNos: AllergenNo[]
}

export class StudentValidationError extends Error {}

export class StudentService {
  private readonly database: BabmuwonDatabase
  private readonly aliasWords: readonly string[]
  private readonly randomIndex: (max: number) => number
  private readonly repository: StudentRepository
  private readonly conflicts: ConflictRepository

  constructor(
    database: BabmuwonDatabase,
    aliasWords: readonly string[] = ALIAS_WORDS,
    randomIndex: (max: number) => number = secureRandomIndex,
  ) {
    this.database = database
    this.aliasWords = aliasWords
    this.randomIndex = randomIndex
    this.repository = new StudentRepository(database)
    this.conflicts = new ConflictRepository(database)
  }

  async getAll(): Promise<StudentRecord[]> {
    const students = await this.repository.getAll()
    const records = await Promise.all(students.map(async (student) => ({
      student,
      allergenNos: (await this.repository.getAllergies(student.id)).map((item) => item.allergenNo).sort((a, b) => a - b),
    })))
    return records.sort((a, b) => a.student.grade - b.student.grade || a.student.class - b.student.class || a.student.number - b.student.number)
  }

  async create(input: StudentInput): Promise<StudentRecord> {
    this.validate(input)
    await this.assertClassNumberAvailable(input)
    const now = new Date().toISOString()
    const student: Student = {
      id: crypto.randomUUID(),
      grade: input.grade,
      class: input.class,
      number: input.number,
      alias: await this.generateAlias(input.realName),
      realName: cleanOptional(input.realName),
      needsSubstitute: input.needsSubstitute,
      memo: input.memo.trim(),
      createdAt: now,
      updatedAt: now,
    }
    await this.repository.save(student, input.allergenNos)
    await this.conflicts.refreshConfirmedPlans()
    return { student, allergenNos: [...input.allergenNos].sort((a, b) => a - b) }
  }

  async update(id: string, input: StudentInput): Promise<StudentRecord> {
    this.validate(input)
    const current = await this.repository.get(id)
    if (!current) throw new StudentValidationError('학생 정보를 찾을 수 없습니다.')
    await this.assertClassNumberAvailable(input, id)
    const student: Student = {
      ...current,
      grade: input.grade,
      class: input.class,
      number: input.number,
      realName: cleanOptional(input.realName),
      needsSubstitute: input.needsSubstitute,
      memo: input.memo.trim(),
      updatedAt: new Date().toISOString(),
    }
    await this.repository.save(student, input.allergenNos)
    await this.conflicts.refreshConfirmedPlans()
    return { student, allergenNos: [...input.allergenNos].sort((a, b) => a - b) }
  }

  async regenerateAlias(id: string): Promise<StudentRecord> {
    const student = await this.repository.get(id)
    if (!student) throw new StudentValidationError('학생 정보를 찾을 수 없습니다.')
    const allergenNos = (await this.repository.getAllergies(id)).map((item) => item.allergenNo)
    const updated = { ...student, alias: await this.generateAlias(student.realName), updatedAt: new Date().toISOString() }
    await this.repository.save(updated, allergenNos)
    await this.conflicts.refreshConfirmedPlans()
    return { student: updated, allergenNos: allergenNos.sort((a, b) => a - b) }
  }

  async delete(id: string): Promise<void> {
    if (!await this.repository.get(id)) throw new StudentValidationError('학생 정보를 찾을 수 없습니다.')
    await this.repository.delete(id)
    await this.conflicts.refreshConfirmedPlans()
  }

  private validate(input: StudentInput): void {
    if (!Number.isInteger(input.grade) || input.grade < 1 || input.grade > 6) throw new StudentValidationError('학년은 1~6 사이의 정수여야 합니다.')
    if (!Number.isInteger(input.class) || input.class < 1 || input.class > 99) throw new StudentValidationError('반은 1~99 사이의 정수여야 합니다.')
    if (!Number.isInteger(input.number) || input.number < 1 || input.number > 99) throw new StudentValidationError('번호는 1~99 사이의 정수여야 합니다.')
    if (input.allergenNos.length === 0) throw new StudentValidationError('알레르기 항목을 1개 이상 선택해 주세요.')
    if (new Set(input.allergenNos).size !== input.allergenNos.length || input.allergenNos.some((no) => no < 1 || no > 19)) {
      throw new StudentValidationError('알레르기 번호가 올바르지 않습니다.')
    }
  }

  private async assertClassNumberAvailable(input: StudentInput, exceptId?: string): Promise<void> {
    const duplicate = await this.repository.getByClassNumber(input.grade, input.class, input.number)
    if (duplicate && duplicate.id !== exceptId) throw new StudentValidationError('같은 학년·반·번호의 학생이 이미 등록되어 있습니다.')
  }

  private async generateAlias(realName?: string): Promise<string> {
    const [history, students, school, entries] = await Promise.all([
      this.repository.getAliasHistory(),
      this.repository.getAll(),
      this.database.schools.get('school'),
      this.database.mealEntries.toArray(),
    ])
    const used = new Set([...history.map((item) => item.alias), ...students.map((student) => student.alias)])
    const forbidden = [
      ...ALLERGEN_ITEMS.flatMap((item) => [item.name, ...item.includes]),
      ...students.flatMap((student) => student.realName ? [student.realName] : []),
      ...entries.map((entry) => entry.menuName),
      school?.name ?? '',
      realName ?? '',
    ].map(normalize).filter(Boolean)
    const words = this.aliasWords.filter((word) => {
      const normalized = normalize(word)
      return normalized && !forbidden.some((term) => term.includes(normalized) || normalized.includes(term))
    })
    if (words.length === 0) throw new StudentValidationError('사용할 수 있는 가명 단어가 없습니다.')

    for (let attempt = 0; attempt < words.length * 100; attempt += 1) {
      const word = words[this.randomIndex(words.length)]
      const suffix = String(this.randomIndex(100)).padStart(2, '0')
      const alias = `${word}-${suffix}`
      if (!used.has(alias)) return alias
    }
    throw new StudentValidationError('중복되지 않는 가명을 만들 수 없습니다. 다시 시도해 주세요.')
  }
}

function secureRandomIndex(max: number): number {
  if (max <= 0) throw new Error('INVALID_RANDOM_RANGE')
  const values = new Uint32Array(1)
  crypto.getRandomValues(values)
  return values[0] % max
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/[\s_-]/g, '').toLocaleLowerCase('ko-KR')
}

function cleanOptional(value?: string): string | undefined {
  const cleaned = value?.trim()
  return cleaned || undefined
}

export const studentService = new StudentService(db)
