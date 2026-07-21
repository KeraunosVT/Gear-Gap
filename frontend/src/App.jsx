import { BrowserRouter as Router, Routes, Route, Outlet } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import EliteTimerBar from './components/EliteTimerBar';
import Sigil from './components/Sigil';
import Home from './pages/Home';
import MatchStats from './pages/MatchStats';
import Roster from './pages/Roster';
import Shards from './pages/Shards';
import Loot from './pages/Loot';
import Login from './pages/Login';
import Admin from './pages/Admin';
import Parties from './pages/Parties';
import Names from './pages/Names';
import LootTally from './pages/LootTally';
import LootHistory from './pages/LootHistory';
import Attendance from './pages/Attendance';
import PlayerProfile from './pages/PlayerProfile';
import LOA from './pages/LOA';
import Classes from './pages/Classes';
import GearLevel from './pages/GearLevel';
import GearLevels from './pages/GearLevels';

function Layout() {
  return (
    <div className="h-screen bg-ink text-bone flex">
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <Topbar />
        <EliteTimerBar />
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Splash() {
  return (
    <div className="min-h-screen bg-ink flex flex-col items-center justify-center gap-5">
      <Sigil className="w-12 h-16 text-brass rise" />
      <div className="eyebrow text-[10px] text-ash">Verifying standing…</div>
    </div>
  );
}

// Full login wall: nothing past the gate renders without a valid session.
function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <Splash />;
  if (!user) return <Login />;

  return (
    <Router>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/war-record" element={<MatchStats />} />
          <Route path="/roster" element={<Roster />} />
          <Route path="/roster/:name" element={<PlayerProfile />} />
          <Route path="/shards" element={<Shards />} />
          <Route path="/loot" element={<Loot />} />
          <Route path="/loa" element={<LOA />} />
          <Route path="/classes" element={<Classes />} />
          <Route path="/gear" element={<GearLevel />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/admin/parties" element={<Parties />} />
          <Route path="/admin/names" element={<Names />} />
          <Route path="/admin/loot" element={<LootTally />} />
          <Route path="/admin/loot/history" element={<LootHistory />} />
          <Route path="/admin/attendance" element={<Attendance />} />
          <Route path="/admin/gear-levels" element={<GearLevels />} />
          {/* Legacy aliases kept so old links still resolve */}
          <Route path="/dashboard" element={<MatchStats />} />
          <Route path="/match-stats" element={<MatchStats />} />
        </Route>
      </Routes>
    </Router>
  );
}

function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

export default App;
