import type { BabmuwonDatabase } from '../database'
import type { AliasHistory, AllergenNo, EntityId, Student, StudentAllergy } from '../types'
import { VersionRepository } from './versionRepository'

export class StudentRepository {
  private readonly db: BabmuwonDatabase
  private readonly versions: VersionRepository
  constructor(db: BabmuwonDatabase) {
    this.db = db
    this.versions = new VersionRepository(db)
  }

  get(id: EntityId) { return this.db.students.get(id) }
  getAll() { return this.db.students.toArray() }
  getAllergies(studentId: EntityId) { return this.db.studentAllergies.where('studentId').equals(studentId).toArray() }
  getByClassNumber(grade: number, classNumber: number, number: number) {
    return this.db.students.where('[grade+class+number]').equals([grade, classNumber, number]).first()
  }
  getAliasHistory() { return this.db.aliasHistories.toArray() }

  async save(student: Student, allergenNos: AllergenNo[]): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.students, this.db.studentAllergies, this.db.aliasHistories, this.db.dataVersions, this.db.generatedDocs],
      async (transaction) => {
      await this.db.students.put(student)
      const aliasHistory: AliasHistory = { alias: student.alias, createdAt: student.updatedAt }
      await this.db.aliasHistories.put(aliasHistory)
      await this.db.studentAllergies.where('studentId').equals(student.id).delete()
      const allergies: StudentAllergy[] = allergenNos.map((allergenNo) => ({
        id: `${student.id}:${allergenNo}`, studentId: student.id, allergenNo,
      }))
      await this.db.studentAllergies.bulkPut(allergies)
      const version = await this.versions.bump('studentVersion', transaction)
      await this.markStudentDocumentsStale(student.id, version.studentVersion, student.updatedAt)
      },
    )
  }

  async delete(id: EntityId): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.students, this.db.studentAllergies, this.db.dataVersions, this.db.generatedDocs],
      async (transaction) => {
      const deletedAt = new Date().toISOString()
      await this.db.studentAllergies.where('studentId').equals(id).delete()
      await this.db.students.delete(id)
      const version = await this.versions.bump('studentVersion', transaction)
      await this.markStudentDocumentsStale(id, version.studentVersion, deletedAt)
      },
    )
  }

  private async markStudentDocumentsStale(studentId: EntityId, studentVersion: number, updatedAt: string): Promise<void> {
    const documents = await this.db.generatedDocs.where('status').anyOf('approved', 'sent').toArray()
    const affected = documents.filter((document) =>
      (['S3', 'S5'].includes(document.docType) || (document.docType === 'S4' && (document.subjectId === undefined || document.subjectId === studentId)))
      && document.basedOn.studentVersion !== studentVersion,
    )
    await this.db.generatedDocs.bulkPut(affected.map((document) => ({
      ...document,
      status: 'stale' as const,
      approvedAt: undefined,
      staleReason: '학생 알레르기 정보가 변경되어 재검토가 필요합니다.',
      correctionNeeded: document.status === 'sent',
      updatedAt,
    })))
  }
}
