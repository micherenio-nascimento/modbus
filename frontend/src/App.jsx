import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import alytechLogo from './assets/alytech-logo.svg'

const TOKEN_KEY = 'dse855.auth.token'
const DASHBOARD_URL = '/d/dse855-scada/dse-855-scada?orgId=1&from=now-5m&to=now&timezone=browser&refresh=5s&kiosk'
const emptyUserForm = { name: '', email: '', password: '' }

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  const responseText = await response.text()
  const contentType = response.headers.get('content-type') || ''
  const isJson = contentType.includes('application/json')
  let payload = {}

  if (responseText && isJson) {
    try {
      payload = JSON.parse(responseText)
    } catch {
      throw new Error('A API retornou JSON invalido. Verifique os logs do backend.')
    }
  } else if (responseText) {
    throw new Error('A API retornou uma resposta invalida. Verifique o proxy /auth no servidor.')
  }

  if (!response.ok) {
    throw new Error(payload.error || 'Nao foi possivel concluir a operacao.')
  }

  return payload
}

function App() {
  const [loginForm, setLoginForm] = useState({ email: '', password: '' })
  const [userForm, setUserForm] = useState(emptyUserForm)
  const [editingUserId, setEditingUserId] = useState(null)
  const [users, setUsers] = useState([])
  const [view, setView] = useState('dashboard')
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY))
  const [isLoading, setIsLoading] = useState(Boolean(token))
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isUsersLoading, setIsUsersLoading] = useState(false)
  const [error, setError] = useState('')
  const [usersError, setUsersError] = useState('')

  const authHeaders = useMemo(() => ({
    Authorization: `Bearer ${token}`,
  }), [token])

  const initials = useMemo(() => {
    const source = user?.name || user?.email || ''
    return source
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('')
  }, [user])

  const loadUsers = useCallback(async () => {
    setUsersError('')
    setIsUsersLoading(true)

    try {
      const payload = await apiRequest('/auth/users', {
        method: 'GET',
        headers: authHeaders,
      })
      setUsers(payload.users)
    } catch (requestError) {
      setUsersError(requestError.message)
    } finally {
      setIsUsersLoading(false)
    }
  }, [authHeaders])

  useEffect(() => {
    if (!token) return

    let ignore = false

    apiRequest('/auth/me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
      .then(({ user: currentUser }) => {
        if (!ignore) setUser(currentUser)
      })
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY)
        if (!ignore) {
          setToken(null)
          setUser(null)
        }
      })
      .finally(() => {
        if (!ignore) setIsLoading(false)
      })

    return () => {
      ignore = true
    }
  }, [token])

  function handleLoginChange(event) {
    const { name, value } = event.target
    setLoginForm((current) => ({ ...current, [name]: value }))
  }

  function handleUserFormChange(event) {
    const { name, value } = event.target
    setUserForm((current) => ({ ...current, [name]: value }))
  }

  async function handleLoginSubmit(event) {
    event.preventDefault()
    setError('')
    setIsSubmitting(true)

    try {
      const payload = await apiRequest('/auth/login', {
        method: 'POST',
        body: JSON.stringify(loginForm),
      })

      localStorage.setItem(TOKEN_KEY, payload.token)
      setToken(payload.token)
      setUser(payload.user)
      setLoginForm({ email: '', password: '' })
      setView('dashboard')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleUserSubmit(event) {
    event.preventDefault()
    setUsersError('')
    setIsSubmitting(true)

    const payload = {
      ...userForm,
      password: userForm.password.trim(),
    }

    try {
      await apiRequest(editingUserId ? `/auth/users/${editingUserId}` : '/auth/users', {
        method: editingUserId ? 'PUT' : 'POST',
        headers: authHeaders,
        body: JSON.stringify(payload),
      })
      setUserForm(emptyUserForm)
      setEditingUserId(null)
      await loadUsers()
    } catch (requestError) {
      setUsersError(requestError.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleEditUser(selectedUser) {
    setEditingUserId(selectedUser.id)
    setUserForm({ name: selectedUser.name, email: selectedUser.email, password: '' })
    setUsersError('')
  }

  function openUsersView() {
    setView('users')
    loadUsers()
  }

  function cancelEdit() {
    setEditingUserId(null)
    setUserForm(emptyUserForm)
    setUsersError('')
  }

  async function handleDeleteUser(selectedUser) {
    setUsersError('')
    setIsSubmitting(true)

    try {
      await apiRequest(`/auth/users/${selectedUser.id}`, {
        method: 'DELETE',
        headers: authHeaders,
      })
      if (editingUserId === selectedUser.id) cancelEdit()
      await loadUsers()
    } catch (requestError) {
      setUsersError(requestError.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleLogout() {
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
    setUser(null)
    setView('dashboard')
    setError('')
    setUsersError('')
    setUsers([])
    setUserForm(emptyUserForm)
    setEditingUserId(null)
  }

  if (isLoading) {
    return (
      <div className="app-shell loading-shell">
        <img className="loading-logo" src={alytechLogo} alt="ALYTECH Solucoes e Servicos" />
        <span className="loading-indicator" />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="auth-page">
        <main className="auth-layout">
          <section className="auth-brand" aria-label="ALYTECH">
            <img className="auth-logo" src={alytechLogo} alt="ALYTECH Solucoes e Servicos" />
            <h1>DSE 855 SCADA</h1>
            <p>Acesso seguro ao painel operacional.</p>
          </section>

          <section className="auth-panel" aria-label="Autenticacao">
            <form className="auth-form" onSubmit={handleLoginSubmit}>
              <div className="form-heading">
                <h2>Entrar na conta</h2>
                <p>Informe suas credenciais.</p>
              </div>

              <label className="field">
                <span>E-mail</span>
                <input
                  autoComplete="email"
                  inputMode="email"
                  name="email"
                  onChange={handleLoginChange}
                  placeholder="usuario@empresa.com"
                  required
                  type="email"
                  value={loginForm.email}
                />
              </label>

              <label className="field">
                <span>Senha</span>
                <input
                  autoComplete="current-password"
                  minLength={8}
                  name="password"
                  onChange={handleLoginChange}
                  placeholder="Minimo de 8 caracteres"
                  required
                  type="password"
                  value={loginForm.password}
                />
              </label>

              {error && <p className="form-error">{error}</p>}

              <button className="submit-button" disabled={isSubmitting} type="submit">
                {isSubmitting ? 'Aguarde...' : 'Entrar'}
              </button>
            </form>
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <img className="app-logo" src={alytechLogo} alt="ALYTECH Solucoes e Servicos" />
        <nav className="app-nav" aria-label="Navegacao principal">
          <button
            className={view === 'dashboard' ? 'active' : ''}
            type="button"
            onClick={() => setView('dashboard')}
          >
            Dashboard
          </button>
          {user.isAdmin && (
            <button
              className={view === 'users' ? 'active' : ''}
              type="button"
              onClick={openUsersView}
            >
              Usuarios
            </button>
          )}
        </nav>
        <div className="user-area">
          <span className="user-avatar" aria-hidden="true">{initials || 'U'}</span>
          <span className="user-name">{user.name}</span>
          <button className="logout-button" type="button" onClick={handleLogout}>
            Sair
          </button>
        </div>
      </header>

      {view === 'users' && user.isAdmin ? (
        <main className="users-shell">
          <section className="users-form-panel" aria-label="Formulario de usuario">
            <div className="section-heading">
              <h2>{editingUserId ? 'Editar usuario' : 'Novo usuario'}</h2>
              <p>{editingUserId ? 'Deixe a senha em branco para manter a atual.' : 'Usuarios criados aqui podem acessar o dashboard.'}</p>
            </div>

            <form className="users-form" onSubmit={handleUserSubmit}>
              <label className="field">
                <span>Nome</span>
                <input
                  autoComplete="name"
                  name="name"
                  onChange={handleUserFormChange}
                  placeholder="Nome do usuario"
                  required
                  type="text"
                  value={userForm.name}
                />
              </label>

              <label className="field">
                <span>E-mail</span>
                <input
                  autoComplete="email"
                  inputMode="email"
                  name="email"
                  onChange={handleUserFormChange}
                  placeholder="usuario@empresa.com"
                  required
                  type="email"
                  value={userForm.email}
                />
              </label>

              <label className="field">
                <span>Senha</span>
                <input
                  autoComplete="new-password"
                  minLength={editingUserId ? undefined : 8}
                  name="password"
                  onChange={handleUserFormChange}
                  placeholder={editingUserId ? 'Opcional' : 'Minimo de 8 caracteres'}
                  required={!editingUserId}
                  type="password"
                  value={userForm.password}
                />
              </label>

              {usersError && <p className="form-error">{usersError}</p>}

              <div className="form-actions">
                {editingUserId && (
                  <button className="secondary-button" type="button" onClick={cancelEdit}>
                    Cancelar
                  </button>
                )}
                <button className="submit-button" disabled={isSubmitting} type="submit">
                  {isSubmitting ? 'Salvando...' : editingUserId ? 'Salvar' : 'Criar'}
                </button>
              </div>
            </form>
          </section>

          <section className="users-list-panel" aria-label="Usuarios cadastrados">
            <div className="section-heading">
              <h2>Usuarios</h2>
              <p>{isUsersLoading ? 'Carregando...' : `${users.length} usuario(s) cadastrado(s).`}</p>
            </div>

            <div className="users-list">
              {users.map((listedUser) => (
                <article className="user-row" key={listedUser.id}>
                  <div className="user-row-main">
                    <strong>{listedUser.name}</strong>
                    <span>{listedUser.email}</span>
                  </div>
                  <div className="row-actions">
                    {listedUser.isAdmin && <span className="admin-badge">Principal</span>}
                    <button type="button" onClick={() => handleEditUser(listedUser)}>
                      Editar
                    </button>
                    <button
                      className="danger-button"
                      disabled={listedUser.isAdmin}
                      type="button"
                      onClick={() => handleDeleteUser(listedUser)}
                    >
                      Excluir
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </main>
      ) : (
        <main className="dashboard-shell">
          <iframe
            className="dashboard-frame"
            src={DASHBOARD_URL}
            title="Grafana Dashboard"
          />
        </main>
      )}
    </div>
  )
}

export default App
