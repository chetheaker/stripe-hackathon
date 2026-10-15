import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '@fontsource-variable/fraunces'
import '@fontsource-variable/fraunces/wght-italic.css'
import '@fontsource-variable/inter'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/anton'
import '@fontsource-variable/archivo'
import './styles.css'

import App from './App.jsx'
import './theme-riso.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
