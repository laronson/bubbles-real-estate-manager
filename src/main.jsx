import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

const newAttribute = Symbol('new attribute')

async function request(path, options) {
  const response = await fetch(path, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error)
  return data
}

function useResource(path) {
  const [resource, setResource] = useState({ loading: true })
  useEffect(() => {
    const controller = new AbortController()
    request(path, { signal: controller.signal })
      .then(data => setResource({ data }))
      .catch(error => {
        if (!controller.signal.aborted) setResource({ error: error.message })
      })
    return () => controller.abort()
  }, [path])
  return resource
}

function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      <i /><i /><i />
    </span>
  )
}

function CollectionLists({ groups }) {
  return (
    <div className="collections">
      {groups.map(({ collection, items }) => (
        <section className="panel collection" key={collection}>
          <h3>{collection}<small>{items.length}</small></h3>
          <ul>
            {items.map(item => {
              const query = new URLSearchParams({ collection, id: item.id })
              if (item.bsonId) query.set('bsonId', item.bsonId)
              return <li key={item.bsonId ?? item.id}><a href={`/record?${query}`}>{item.description ?? item.id}</a></li>
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

function SearchPage() {
  const buildings = useResource('/api/buildings')
  const [selectedBuildingId, setSelectedBuildingId] = useState(null)
  const [unitId, setUnitId] = useState('')
  const [results, setResults] = useState(null)
  const onlyBuildingId = buildings.data?.length === 1 ? buildings.data[0]._id : ''
  const building = buildings.data?.find(item => item._id === (selectedBuildingId ?? onlyBuildingId))
  const buildingId = building?._id ?? ''
  const unit = building?.units?.find(item => item.id === unitId)
  const scope = unit ? `${building.name || building.address} · ${unit.label}` : building?.name || building?.address

  async function search(event) {
    event.preventDefault()
    if (!buildingId || results?.loading) return
    setResults({ loading: true })
    try {
      const query = new URLSearchParams({ buildingId })
      if (unitId) query.set('unitId', unitId)
      setResults({ groups: await request(`/api/search?${query}`) })
    } catch (error) {
      setResults({ error: error.message })
    }
  }

  return (
    <>
      <section className="intro">
        <h1>Browse inventory</h1>
        <p>Find records for a building or an individual unit.</p>
      </section>

      <form className="panel search" onSubmit={search} aria-label="Inventory search">
        <label>
          <span>Building</span>
          <select required value={buildingId} disabled={!buildings.data?.length || results?.loading}
            onChange={event => {
              setSelectedBuildingId(event.target.value)
              setUnitId('')
              setResults(null)
            }}>
            <option value="">{buildings.loading ? 'Loading buildings…' : 'Select a building'}</option>
            {buildings.data?.map(item => (
              <option key={item._id} value={item._id}>
                {item.name || item.address}{item.name && item.address ? ` · ${item.address}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Unit <small>Optional</small></span>
          <select value={unitId} disabled={!building?.units?.length || results?.loading}
            onChange={event => {
              setUnitId(event.target.value)
              setResults(null)
            }}>
            <option value="">Whole building</option>
            {building?.units?.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <button disabled={!buildingId || results?.loading}>{results?.loading ? 'Searching…' : 'Search'}</button>
      </form>

      {buildings.error && <p className="error" role="alert">{buildings.error}</p>}
      {buildings.data?.length === 0 && <p role="status">No buildings found.</p>}
      {results?.error && <p className="error" role="alert">{results.error}</p>}
      {results?.loading && <p role="status" className="feedback">Searching inventory…</p>}
      {results?.groups && (
        <section className="results" aria-labelledby="results-heading" aria-live="polite">
          <h2 id="results-heading">{scope}</h2>
          {results.groups.length === 0 && <p className="panel feedback">No records found.</p>}
          <CollectionLists groups={results.groups} />
        </section>
      )}
    </>
  )
}

function RecordFieldEditor({ name, editText, recordUrl, onSave, onCancel }) {
  const adding = name === undefined
  const [draftName, setDraftName] = useState('')
  const [draft, setDraft] = useState(editText ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function save(event) {
    event.preventDefault()
    if (saving) return
    const fieldName = adding ? draftName.trim() : name
    if (!fieldName) {
      setError('Enter an attribute name.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const field = await request(recordUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: fieldName, original: editText ?? null, text: draft }),
      })
      onSave(fieldName, field)
    } catch (error) {
      setError(error.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className={adding ? 'field-add-row' : undefined} onSubmit={save} onKeyDown={event => {
      if (event.key === 'Escape' && !saving) onCancel()
    }}>
      {adding && (
        <input type="text" aria-label="Attribute name" placeholder="Attribute name" value={draftName}
          autoFocus required readOnly={saving} onChange={event => setDraftName(event.target.value)} />
      )}
      <div className="field-editor field-editor-active">
        <textarea aria-label={adding ? 'Attribute value' : `Edit ${name}`}
          placeholder={adding ? 'Attribute value' : undefined} value={draft}
          rows={editText?.includes('\n') ? 5 : 1} autoFocus={!adding} readOnly={saving}
          onChange={event => setDraft(event.target.value)} />
        <div className="field-actions">
          <button type="button" className="field-cancel"
            aria-label={adding ? 'Cancel adding attribute' : `Cancel editing ${name}`}
            disabled={saving} onClick={onCancel}>Cancel</button>
          <button className="field-save" aria-label={adding ? 'Save new attribute' : `Save ${name}`} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </form>
  )
}

function RecordField({ name, value, onEdit, children }) {
  const number = value?.$numberInt ?? value?.$numberDouble ?? value?.$numberLong ?? value?.$numberDecimal
  const display = typeof value === 'string' ? value : number ?? <pre>{JSON.stringify(value, null, 2)}</pre>
  return (
    <div>
      <dt>{name}</dt>
      <dd>
        {children ?? (onEdit ? (
          <div className="field-editor">
            <div>{display}</div>
            <button className="field-edit" type="button" aria-label={`Edit ${name}`}
              title={`Edit ${name}`} onClick={onEdit}>
              <span aria-hidden="true">✎</span>
            </button>
          </div>
        ) : display)}
      </dd>
    </div>
  )
}

function RelatedRecords() {
  const { data: groups, error, loading } = useResource(`/api/record/related${window.location.search}`)
  return (
    <section className="results" aria-labelledby="related-records-heading" aria-live="polite">
      <h2 id="related-records-heading">Related records</h2>
      {loading && <p role="status">Loading related records…</p>}
      {error && <p className="error" role="alert">Could not load related records.</p>}
      {groups?.length === 0 && <p className="panel feedback">No related records found.</p>}
      {groups?.length > 0 && <CollectionLists groups={groups} />}
    </section>
  )
}

function RecordPage() {
  const query = new URLSearchParams(window.location.search)
  const collection = query.get('collection')
  const recordUrl = `/api/record?${query}`
  query.set('edit', '1')
  const { data: record, error, loading } = useResource(`/api/record?${query}`)
  const [savedFields, setSavedFields] = useState({})
  const [editingField, setEditingField] = useState(null)
  const data = record?.data

  function saveField(name, field) {
    setSavedFields(fields => ({ ...fields, [name]: field }))
    setEditingField(null)
  }

  function cancelEdit() {
    setEditingField(null)
  }

  return (
    <>
      <a className="back" href="/">Browse inventory</a>
      <section className="intro">
        <h1>{data ? (savedFields.description?.value ?? data.description ?? query.get('id')) : 'Record details'}</h1>
        {collection && <p>{collection}</p>}
      </section>
      {loading && <p role="status">Loading record…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {data && (
        <>
          <div className="fields-toolbar">
            <button type="button" className="field-add" aria-label="Add attribute" title="Add attribute"
              disabled={editingField !== null} onClick={() => setEditingField(newAttribute)}>+</button>
          </div>
          <div className="panel">
            <dl className="fields">
              {[...new Set([...Object.keys(data), ...Object.keys(savedFields)])].map(name => {
                const saved = Object.hasOwn(savedFields, name) ? savedFields[name] : null
                const initialText = Object.hasOwn(record.editableFields, name) ? record.editableFields[name] : undefined
                const editText = saved ? saved.editText : initialText
                const canStartEditing = editingField === null && editText !== undefined
                return (
                  <RecordField key={name} name={name} value={saved ? saved.value : data[name]}
                    onEdit={canStartEditing ? () => setEditingField(name) : undefined}>
                    {editingField === name ? (
                      <RecordFieldEditor name={name} editText={editText} recordUrl={recordUrl}
                        onSave={saveField} onCancel={cancelEdit} />
                    ) : null}
                  </RecordField>
                )
              })}
            </dl>
            {editingField === newAttribute && (
              <RecordFieldEditor recordUrl={recordUrl} onSave={saveField} onCancel={cancelEdit} />
            )}
          </div>
          <RelatedRecords />
        </>
      )}
    </>
  )
}

createRoot(document.getElementById('root')).render(
  <>
    <header><div className="shell"><a className="brand" href="/"><Mark />Property Inventory</a></div></header>
    <main className="shell">{window.location.pathname === '/record' ? <RecordPage /> : <SearchPage />}</main>
  </>,
)
