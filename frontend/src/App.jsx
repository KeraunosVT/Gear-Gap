import { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Outlet } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import Sidebar, { SIDEBAR_COLLAPSE_KEY, getInitialSidebarCollapsed } from './components/Sidebar';
import ErrorBoundary, { RouteErrorBoundary } from './components/ErrorBoundary';
import Topbar from './components/Topbar';
import EliteTimerBar from './components/EliteTimerBar';
import Sigil from './components/Sigil';
import Home from './pages/Home';
import MatchStats from './pages/MatchStats';
import GuildFeuds from './pages/GuildFeuds';
import GuildFeudRoster from './pages/GuildFeudRoster';
import Roster from './pages/Roster';
import Shards from './pages/Shards';
import Loot from './pages/Loot';
import Login from './pages/Login';
import Admin from './pages/Admin';
import Parties from './pages/Parties';
import Names from './pages/Names';
import LootTally from './pages/LootTally';
import LootItems from './pages/LootItems';
import LootCurrency from './pages/LootCurrency';
import LootRequests from './pages/LootRequests';
import Permissions from './pages/Permissions';
import GuildSettings from './pages/GuildSettings';
import MyProfile from './pages/MyProfile';
import LootHistory from './pages/LootHistory';
import LootFairness from './pages/LootFairness';
import Attendance from './pages/Attendance';
import PlayerProfile from './pages/PlayerProfile';
import LOA from './pages/LOA';
import Signups from './pages/Signups';
import MyAttendance from './pages/MyAttendance';
import EventAttendance from './pages/EventAttendance';
import EventCalendar from './pages/EventCalendar';
import Classes from './pages/Classes';
import GearLevel from './pages/GearLevel';
import GearLevels from './pages/GearLevels';
import AuditLog from './pages/AuditLog';

function Layout() {
  const [collapsed, setCollapsed] = useState(getInitialSidebarCollapsed);

  const toggleSidebar = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(SIDEBAR_COLLAPSE_KEY, String(next));
      return next;
    });
  };

  return (
    <div className="h-screen bg-ink text-bone flex shell-vignette">
      <Sidebar collapsed={collapsed} />
      <div className="flex-1 min-w-0 flex flex-col">
        <EliteTimerBar />
        <Topbar collapsed={collapsed} onToggleSidebar={toggleSidebar} />
        {/* Wraps the page, not the shell. A crash in one page leaves the
            sidebar and topbar standing, so the fallback has somewhere to send
            you — and navigating away clears it, because the boundary resets on
            the pathname. */}
        <main className="flex-1 overflow-y-auto">
          <RouteErrorBoundary>
            <Outlet />
          </RouteErrorBoundary>
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
          <Route path="/war-record/feuds" element={<GuildFeuds />} />
          <Route path="/war-record/feuds/:guild" element={<GuildFeudRoster />} />
          <Route path="/roster" element={<Roster />} />
          <Route path="/roster/:name" element={<PlayerProfile />} />
          <Route path="/me" element={<MyProfile />} />
          <Route path="/shards" element={<Shards />} />
          <Route path="/loot" element={<Loot />} />
          <Route path="/loa" element={<LOA />} />
          <Route path="/signups" element={<Signups />} />
          <Route path="/attendance" element={<MyAttendance />} />
          {/* Above /attendance/:id in the file for readability only — router
              ranking already prefers the static segment over the dynamic one,
              so EventAttendance can never be handed id="calendar". */}
          <Route path="/attendance/calendar" element={<EventCalendar />} />
          <Route path="/attendance/:id" element={<EventAttendance />} />
          <Route path="/classes" element={<Classes />} />
          <Route path="/gear" element={<GearLevel />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/admin/parties" element={<Parties />} />
          <Route path="/admin/names" element={<Names />} />
          <Route path="/admin/loot" element={<LootTally />} />
          <Route path="/admin/loot/items" element={<LootItems />} />
          <Route path="/admin/loot/currency" element={<LootCurrency />} />
          <Route path="/admin/loot/requests" element={<LootRequests />} />
          <Route path="/admin/loot/history" element={<LootHistory />} />
          <Route path="/admin/loot/fairness" element={<LootFairness />} />
          <Route path="/admin/attendance" element={<Attendance />} />
          <Route path="/admin/gear-levels" element={<GearLevels />} />
          <Route path="/admin/permissions" element={<Permissions />} />
          <Route path="/admin/audit-log" element={<AuditLog />} />
          <Route path="/admin/settings" element={<GuildSettings />} />
          {/* Legacy aliases kept so old links still resolve */}
          <Route path="/dashboard" element={<MatchStats />} />
          <Route path="/match-stats" element={<MatchStats />} />
        </Route>
      </Routes>
    </Router>
  );
}

// The outer boundary covers what the page-level one can't reach: the shell
// itself (Sidebar, Topbar, EliteTimerBar), the login screen, and AuthProvider.
// A crash in any of those happens outside the Router, so there is nowhere to
// navigate to and reload is the only offer — which is why this one is
// fullscreen and the inner one isn't.
function App() {
  return (
    <ErrorBoundary fullscreen>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
