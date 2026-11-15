import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import Demo from './Demo'
import './globals.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {import.meta.env.VITE_DEMO === 'true' ? <Demo /> : <App />}
  </React.StrictMode>,
)
