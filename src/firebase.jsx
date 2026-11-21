import { useEffect, useState } from 'react'
import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'

let auth

function inventoryAuth() {
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY
  if (!projectId || !apiKey) throw new Error('Could not load sign-in settings.')
  auth ??= getAuth(initializeApp({ projectId, apiKey, authDomain: `${projectId}.firebaseapp.com` }))
  return auth
}

export async function inventoryAuthorization() {
  const auth = inventoryAuth()
  const token = await auth.currentUser?.getIdToken()
  if (!token) throw new Error('Sign in to access the inventory.')
  return `Bearer ${token}`
}

export default function FirebaseAccess({ children }) {
  const [session, setSession] = useState({ loading: true })
  const [actionPending, setActionPending] = useState(false)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    let mounted = true
    let unsubscribe
    let controller

    Promise.resolve().then(inventoryAuth).then(auth => {
      if (!mounted) return
      unsubscribe = onAuthStateChanged(auth, async user => {
        controller?.abort()
        if (!user) {
          setSession({ auth })
          return
        }

        controller = new AbortController()
        const { signal } = controller
        setSession({ loading: true })
        try {
          const token = await user.getIdToken()
          const response = await fetch('/api/access', {
            signal,
            headers: { Authorization: `Bearer ${token}` },
          })
          if (response.status === 403) throw new Error('This Google account does not have inventory access.')
          if (!response.ok) throw new Error('Could not verify inventory access. Sign in again to retry.')
          if (!signal.aborted) setSession({ auth, user, authorized: true })
        } catch (error) {
          if (!signal.aborted) setSession({ auth, user, error: error.message })
        }
      })
    }).catch(() => {
      if (mounted) setSession({ error: 'Could not start Google sign-in. Reload the page to retry.' })
    })

    return () => {
      mounted = false
      unsubscribe?.()
      controller?.abort()
    }
  }, [])

  async function changeAccount() {
    setActionPending(true)
    setActionError('')
    try {
      if (session.user) {
        await signOut(session.auth)
      } else {
        const provider = new GoogleAuthProvider()
        provider.setCustomParameters({ prompt: 'select_account' })
        await signInWithPopup(session.auth, provider)
      }
    } catch {
      setActionError(session.user ? 'Could not sign out. Try again.' : 'Could not sign in. Try again.')
    } finally {
      setActionPending(false)
    }
  }

  if (session.loading) return <p role="status">Checking inventory access…</p>

  return (
    <>
      {!session.authorized && <section className="intro"><h1>Property Inventory</h1></section>}
      <div className="inventory-account">
        {session.user && <p>{session.user.email}</p>}
        {(session.error || actionError) && <p className="error" role="alert">{actionError || session.error}</p>}
        {session.auth && (
          <button type="button" disabled={actionPending} onClick={changeAccount}>
            {session.user ? 'Sign out' : 'Sign in with Google'}
          </button>
        )}
      </div>
      {session.authorized && children}
    </>
  )
}
