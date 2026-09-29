import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { RemoteApp } from './remote/RemoteApp.tsx'
import './styles.css'
import './manual.css'

const root = document.getElementById('root')
if (root === null) throw new Error('#root 不存在')

// 同一份产物两种部署：引擎挂 /qb/（执行者），团队服务挂 /（发起人远程模式）
const remote = !location.pathname.startsWith('/qb')

createRoot(root).render(
  <StrictMode>{remote ? <RemoteApp /> : <App />}</StrictMode>,
)
