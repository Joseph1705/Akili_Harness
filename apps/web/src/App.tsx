import { Navigate, Route, Routes } from 'react-router-dom'
import { useSession } from './state'
import { Login } from './pages/Login'
import { Onboarding } from './pages/Onboarding'
import { Dashboard } from './pages/Dashboard'
import { NewSession } from './pages/NewSession'
import { SessionPage } from './pages/Session'
import { Validations } from './pages/Validations'
import { InvoiceReview } from './pages/InvoiceReview'
import { Packs } from './pages/Packs'
import { Credits } from './pages/Credits'
import { Settings } from './pages/Settings'
import { About } from './pages/About'
import { Platform } from './pages/Platform'

export function App() {
  const { me, loading } = useSession()
  if (loading) return <div className="center-page"><span className="spinner" /></div>
  if (!me) return <Routes><Route path="*" element={<Login />} /></Routes>
  if (!me.org || !me.org.onboarding_done_at) return <Routes><Route path="*" element={<Onboarding />} /></Routes>
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/sessions/nouvelle" element={<NewSession />} />
      <Route path="/sessions/:id" element={<SessionPage />} />
      <Route path="/validations" element={<Validations />} />
      <Route path="/validations/:id" element={<InvoiceReview />} />
      <Route path="/packs" element={<Packs />} />
      <Route path="/credits" element={<Credits />} />
      <Route path="/parametres" element={<Settings />} />
      <Route path="/a-propos" element={<About />} />
      {me.platformAdmin && <Route path="/administration" element={<Platform />} />}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
