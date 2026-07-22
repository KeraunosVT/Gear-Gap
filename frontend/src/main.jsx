import React from 'react'
import ReactDOM from 'react-dom/client'
import axios from 'axios'
import App from './App.jsx'
import { getInitialTheme, applyTheme } from './theme.js'
import { getInitialPalette, applyPalette } from './palette.js'
import './index.css'

// Set before first render so there's no flash of the wrong theme/palette.
applyTheme(getInitialTheme())
applyPalette(getInitialPalette())

// Send the session cookie with every API call (matters if the API is ever
// served from a different origin than the frontend).
axios.defaults.withCredentials = true

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
