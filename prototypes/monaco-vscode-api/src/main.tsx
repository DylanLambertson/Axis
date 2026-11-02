import './styles.css'

// Services first: VS Code's `initialize` can run only once, so it lives outside React's lifecycle.
await import('./vscode/setup')
await import('./AgentView')

const [{ StrictMode }, { createRoot }, { App }] = await Promise.all([
  import('react'),
  import('react-dom/client'),
  import('./App')
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
