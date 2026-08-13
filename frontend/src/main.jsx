import React from 'react'
import ReactDOM from 'react-dom/client'
import axios from 'axios'
import App from './App.jsx'
import { getInitialTheme, applyTheme } from './theme.js'
import { getInitialPalette, applyPalette } from './palette.js'
import { GuildProvider } from './guild.jsx'
import './index.css'

// Set before first render so there's no flash of the wrong theme/palette.
applyTheme(getInitialTheme())
applyPalette(getInitialPalette())

// The browser <title> used to be set right here, synchronously, from a bundled
// guild.json. The house name now arrives over the wire, so it can't be known
// this early — GuildProvider sets it once the fetch lands. index.html carries a
// neutral placeholder for the moment in between.

// Send the session cookie with every API call (matters if the API is ever
// served from a different origin than the frontend).
axios.defaults.withCredentials = true

// GuildProvider wraps everything, including the login page: it holds the house
// name and — the part that actually matters — the timezone and guild-night
// rollover that timeUtils resolves every date against. It renders nothing until
// both are in place.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <GuildProvider>
      <App />
    </GuildProvider>
  </React.StrictMode>
)
