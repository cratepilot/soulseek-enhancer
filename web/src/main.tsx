import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {App} from './App.js'
import './styles.css'

const el = document.getElementById('root')
if (el === null) throw new Error('missing #root element')
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
