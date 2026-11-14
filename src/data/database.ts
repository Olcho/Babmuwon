import Dexie, { type EntityTable } from 'dexie'
import type {
  AllergenItem, ApiCache, ApiCallLog, Conflict, DataVersion, GeneratedDoc,
  Guardian, MealEntry, MealPlan, School, SendBatch, SendRecipient, Student,
  StudentAllergy, SubstituteMenu, Substitution, SubstitutionMemory, TextDraft,
} from './types'

export const DATABASE_NAME = 'babmuwon'

export class BabmuwonDatabase extends Dexie {
  schools!: EntityTable<School, 'id'>
  allergenItems!: EntityTable<AllergenItem, 'no'>
  dataVersions!: EntityTable<DataVersion, 'id'>
  mealPlans!: EntityTable<MealPlan, 'id'>
  mealEntries!: EntityTable<MealEntry, 'id'>
  substituteMenus!: EntityTable<SubstituteMenu, 'id'>
  students!: EntityTable<Student, 'id'>
  studentAllergies!: EntityTable<StudentAllergy, 'id'>
  conflicts!: EntityTable<Conflict, 'id'>
  substitutions!: EntityTable<Substitution, 'id'>
  substitutionMemories!: EntityTable<SubstitutionMemory, 'id'>
  guardians!: EntityTable<Guardian, 'id'>
  textDrafts!: EntityTable<TextDraft, 'id'>
  generatedDocs!: EntityTable<GeneratedDoc, 'id'>
  sendBatches!: EntityTable<SendBatch, 'id'>
  sendRecipients!: EntityTable<SendRecipient, 'id'>
  apiCallLogs!: EntityTable<ApiCallLog, 'id'>
  apiCache!: EntityTable<ApiCache, 'queryHash'>

  constructor(name = DATABASE_NAME) {
    super(name)
    this.version(1).stores({
      schools: 'id',
      allergenItems: 'no, name',
      dataVersions: 'id',
      mealPlans: 'id, &yearMonth, status, updatedAt',
      mealEntries: 'id, mealPlanId, date, slot, [date+slot], allergenStatus',
      substituteMenus: 'id, name, slot, allergenStatus',
      students: 'id, &alias, &[grade+class+number], updatedAt',
      studentAllergies: 'id, studentId, allergenNo, &[studentId+allergenNo]',
      conflicts: 'id, date, studentId, mealEntryId, kind',
      substitutions: 'id, &conflictId, status, updatedAt',
      substitutionMemories: 'id, [originalMenu+allergenKey], count',
      guardians: 'id, phone, &channelMemberId',
      textDrafts: 'id, generatedDocId, docType, approved',
      generatedDocs: 'id, [docType+yearMonth], status, updatedAt',
      sendBatches: 'id, &batchKey, docId, status, createdAt',
      sendRecipients: 'id, batchId, guardianId, requestStatus, deliveryStatus',
      apiCallLogs: 'id, at, endpoint, status',
      apiCache: 'queryHash, createdAt',
    })
  }
}

export const db = new BabmuwonDatabase()
