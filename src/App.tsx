import { AppShell } from './app/AppShell'
import { useScreen, type ScreenId } from './app/navigation'
import { ConflictDetectionPage } from './features/conflicts/ConflictDetectionPage'
import { DocumentPage } from './features/documents/DocumentPage'
import { HomePage } from './features/home/HomePage'
import { MealPlanPage } from './features/meal-plan/MealPlanPage'
import { SchoolSettingsPage } from './features/school/SchoolSettingsPage'
import { MockSendPage } from './features/sending/MockSendPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { StudentAllergyPage } from './features/students/StudentAllergyPage'
import { SubstitutionPage } from './features/substitutions/SubstitutionPage'
import './App.css'

const PAGES: Record<ScreenId, () => React.JSX.Element> = {
  home: HomePage,
  school: SchoolSettingsPage,
  students: StudentAllergyPage,
  meals: MealPlanPage,
  settings: SettingsPage,
  documents: DocumentPage,
  substitutions: SubstitutionPage,
  sending: MockSendPage,
  conflicts: ConflictDetectionPage,
}

/** 화면 전환만 담당한다. 각 화면의 로직은 features/* 서비스에 있다. */
function App() {
  const [screen, setScreen] = useScreen()
  const Page = PAGES[screen]
  return <AppShell screen={screen} onNavigate={setScreen}><Page key={screen} /></AppShell>
}

export default App
