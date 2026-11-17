import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { getMemberTimezone } from './timeUtils';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await axios.get('/api/auth/me');
      setUser(res.data?.user || null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Tells the server which timezone this member is in, so the /loa Discord
  // command can read their times on their own clock without asking — Discord
  // never tells a bot where someone is. Only sent when it changed since the
  // last successful save from this browser; a failure just retries next visit.
  useEffect(() => {
    if (!user?.id) return;
    const tz = getMemberTimezone();
    const key = `syncedTimezone:${user.id}`;
    let last = null;
    try { last = localStorage.getItem(key); } catch { /* storage blocked */ }
    if (!tz || last === tz) return;
    axios.put('/api/my-timezone', { timezone: tz })
      .then(() => { try { localStorage.setItem(key, tz); } catch { /* storage blocked */ } })
      .catch(() => {});
  }, [user?.id]);

  const login = () => { window.location.href = '/api/auth/login'; };

  const logout = async () => {
    try { await axios.post('/api/auth/logout'); } catch { /* ignore */ }
    setUser(null);
  };

  // Does the signed-in member hold a capability? Hiding a control is a courtesy,
  // not a security boundary — every one of these is enforced again server-side
  // (see backend/permissions.js), so a wrong answer here shows or hides a button
  // rather than granting anything.
  //
  // A session issued before capabilities existed has no permissions array; an
  // old admin token counts as full access until it re-verifies, matching the
  // backend's rule so the two can't disagree mid-session.
  const can = useCallback((permission) => {
    if (!user) return false;
    if (Array.isArray(user.permissions)) return user.permissions.includes(permission);
    return !!user.isAdmin;
  }, [user]);

  // For "does this person belong in the admin area at all" — the sidebar section
  // and page gates. Anything finer must ask can() for a specific capability.
  const canAny = useCallback(
    (...permissions) => permissions.some((p) => can(p)),
    [can],
  );

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh, can, canAny }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
