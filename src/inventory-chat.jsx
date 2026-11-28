import { useEffect, useRef, useState } from 'react'
import { Button } from '@ui-sdk/react/button'
import { Field, FieldLabel } from '@ui-sdk/react/field'
import { Textarea } from '@ui-sdk/react/textarea'
import { LoadingStatus } from './loading-status.jsx'

function formatValue(value) {
  if (value === null) return 'Unknown'
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

export function InventoryChat({ request, recordHref, availability }) {
  const [messages, setMessages] = useState([])
  const [prompt, setPrompt] = useState('')
  const [draft, setDraft] = useState(null)
  const [working, setWorking] = useState('')
  const [error, setError] = useState('')
  const log = useRef(null)
  const promptInput = useRef(null)

  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [messages, working])

  function post(path, body) {
    return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  }

  async function send(event) {
    event.preventDefault()
    if (!prompt.trim() || working) return
    const content = prompt.trim()
    const next = [...messages, { id: crypto.randomUUID(), role: 'user', content }]
    setMessages(next)
    setPrompt('')
    setWorking('Preparing entry…')
    setError('')
    try {
      const result = await post('/api/inventory-chat', {
        messages: next.slice(-12).map(({ role, content }) => ({ role, content })),
      })
      setMessages([...next, { id: crypto.randomUUID(), role: 'assistant', content: result.message }])
      setDraft(result.draft ?? null)
    } catch (error) {
      setMessages(messages)
      setPrompt(content)
      setError(error.message)
    } finally {
      setWorking('')
    }
  }

  async function save() {
    if (!draft || working) return
    setWorking('Saving entry…')
    setError('')
    try {
      const { record } = await post('/api/inventory-chat/save', { token: draft.token })
      setMessages(previous => [...previous, { id: crypto.randomUUID(), role: 'assistant', content: 'Entry saved.', record }])
      setDraft(null)
      promptInput.current?.focus()
    } catch (error) {
      setError(error.message)
    } finally {
      setWorking('')
    }
  }

  return (
    <>
      <section className="intro">
        <h1>Inventory chat</h1>
        <p>Describe the record you want to add. Review the details and links before saving.</p>
      </section>
      {availability.loading && <LoadingStatus>Loading inventory chat…</LoadingStatus>}
      {availability.error && <p className="error" role="alert">{availability.error}</p>}
      {availability.data?.enabled === false && <p className="panel feedback">Inventory chat is disabled on this server.</p>}
      {availability.data?.enabled && (
        <section className="panel inventory-chat" aria-label="Add entry">
          {(messages.length > 0 || working) && (
            <div className="chat-log" ref={log} role="log" aria-label="Chat messages" tabIndex={0}>
              {messages.map(({ id, role, content, record }) => (
                <div key={id} className={`chat-message chat-message-${role}`}>
                  <strong>{role === 'user' ? 'You' : 'Inventory assistant'}</strong>
                  <p>{content}</p>
                  {record && <Button render={<a href={recordHref(record.collection, record)} />}>{record.description}</Button>}
                </div>
              ))}
              {working && <LoadingStatus>{working}</LoadingStatus>}
            </div>
          )}
          {draft && (
            <section className="chat-preview" aria-labelledby="entry-preview-heading">
              <h2 id="entry-preview-heading">Proposed entry</h2>
              <p className="chat-collection">Collection <code>{draft.collection}</code></p>
              <dl className="chat-fields">
                {Object.entries(draft.fields).map(([name, value]) => (
                  <div key={name}><dt>{name}</dt><dd>{formatValue(value)}</dd></div>
                ))}
              </dl>
              {draft.links.length > 0 && (
                <>
                  <h3>Links</h3>
                  <ul className="chat-links">
                    {draft.links.map(({ type, description, target }) => (
                      <li key={JSON.stringify([type, target.collection, target.bsonId ?? target.id])}>
                        <Button render={<a href={recordHref(target.collection, target)} />}>{target.description}</Button>
                        <span>{description} · <code>{type}</code></span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="chat-actions">
                <Button type="button" disabled={!!working} onClick={save}
                  data-agent-confirm="Saves the proposed inventory entry and links to MongoDB Atlas.">Save entry</Button>
                <Button type="button" variant="outline" disabled={!!working} onClick={() => {
                  setDraft(null)
                  setError('')
                  promptInput.current?.focus()
                }}>Discard draft</Button>
              </div>
            </section>
          )}
          <form onSubmit={send} aria-label="Send inventory message">
            <Field name="message" className="chat-prompt">
              <FieldLabel>Inventory message</FieldLabel>
              <Textarea ref={promptInput} rows={3} maxLength={3000} required readOnly={!!working} value={prompt} onValueChange={setPrompt}
                placeholder="Add a microwave to unit 3L" submitShortcut="mod+enter" />
            </Field>
            <div className="chat-actions">
              <Button type="submit" disabled={!prompt.trim() || !!working}>Send message</Button>
            </div>
          </form>
          {error && <p className="error" role="alert">{error}</p>}
        </section>
      )}
    </>
  )
}
