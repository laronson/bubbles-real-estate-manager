import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from '@ui-sdk/react/button'
import { DatePicker, DatePickerContent, DatePickerInput, DatePickerTrigger } from '@ui-sdk/react/date-picker'
import { Drawer, DrawerBackdrop, DrawerClose, DrawerContent, DrawerTitle, DrawerTrigger } from '@ui-sdk/react/drawer'
import { Field, FieldLabel } from '@ui-sdk/react/field'
import { Input } from '@ui-sdk/react/input'
import {
  ScrollArea, ScrollAreaContent, ScrollAreaScrollbar, ScrollAreaThumb, ScrollAreaViewport,
} from '@ui-sdk/react/scroll-area'
import { Select, SelectContent, SelectTrigger, SelectValue } from '@ui-sdk/react/select'
import { Textarea } from '@ui-sdk/react/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@ui-sdk/react/tooltip'
import { LoadingStatus } from './loading-status.jsx'
import '@ui-sdk/core/web.css'
import './styles.css'

const newAttribute = Symbol('new attribute')
const renderBuild = import.meta.env.MODE === 'render'
const FirebaseAccess = renderBuild ? lazy(() => import('./firebase.jsx')) : null

async function request(path, options) {
  if (renderBuild) {
    const { inventoryAuthorization } = await import('./firebase.jsx')
    const headers = new Headers(options?.headers)
    headers.set('Authorization', await inventoryAuthorization())
    options = { ...options, headers }
  }
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

function ScrollableRows({ as: List, label, className = '', visibleRowLimit = 5, children }) {
  const listRef = useRef(null)
  const viewportRef = useRef(null)
  const canScroll = children.length > visibleRowLimit

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!canScroll) {
      viewport.style.removeProperty('max-height')
      return
    }

    const visibleRows = Array.from(listRef.current.children).slice(0, visibleRowLimit)
    function updateHeight() {
      const height = visibleRows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0)
      viewport.style.maxHeight = `${height}px`
    }

    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    visibleRows.forEach(row => observer.observe(row, { box: 'border-box' }))
    return () => observer.disconnect()
  }, [canScroll, visibleRowLimit, children])

  return (
    <ScrollArea className="row-scroll-area" type="auto">
      <ScrollAreaViewport ref={viewportRef} className={canScroll ? 'scrollable-rows' : undefined}
        role={canScroll ? 'region' : undefined} aria-label={canScroll ? label : undefined}
        tabIndex={canScroll ? 0 : undefined}>
        <ScrollAreaContent ref={listRef} render={<List />} className={className}>
          {children}
        </ScrollAreaContent>
      </ScrollAreaViewport>
      {canScroll && <ScrollAreaScrollbar orientation="vertical"><ScrollAreaThumb /></ScrollAreaScrollbar>}
    </ScrollArea>
  )
}

function recordHref(collection, item) {
  const query = new URLSearchParams({ collection, id: item.id })
  if (item.bsonId) query.set('bsonId', item.bsonId)
  return `/record?${query}`
}

function CollectionLists({ groups }) {
  return (
    <div className="collections">
      {groups.map(({ collection, items }) => (
        <section className="panel collection" key={collection}>
          <h3>{collection}<small>{items.length}</small></h3>
          <ScrollableRows as="ul" label={collection}>
            {items.map(item => (
              <li key={item.bsonId ?? item.id}>
                <Button render={<a href={recordHref(collection, item)} />}>{item.description ?? item.id}</Button>
              </li>
            ))}
          </ScrollableRows>
        </section>
      ))}
    </div>
  )
}

function PropertySelect({ label, optional, ...props }) {
  return (
    <Field className="property-select">
      <FieldLabel>{label}{optional && <small>Optional</small>}</FieldLabel>
      <Select {...props}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="property-options" align="start" sideOffset={4} />
      </Select>
    </Field>
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
  const buildingOptions = (buildings.data ?? []).map(item => ({
    value: item._id,
    label: item.name && item.address ? `${item.name} · ${item.address}` : item.name || item.address,
  }))
  const unitOptions = [{ value: '', label: 'Whole building' }, ...(building?.units ?? []).map(item => ({
    value: item.id,
    label: item.label,
  }))]

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
        <PropertySelect label="Building" name="buildingId" required value={buildingId || null}
          placeholder={buildings.loading ? 'Loading buildings…' : 'Select a building'}
          items={buildings.data?.length ? [{ value: '', label: 'Select a building' }, ...buildingOptions] : []}
          disabled={!buildings.data?.length || results?.loading} onValueChange={value => {
            setSelectedBuildingId(value ?? '')
            setUnitId('')
            setResults(null)
          }} />
        <PropertySelect label="Unit" optional name="unitId" value={unitId} items={unitOptions}
          disabled={!building?.units?.length || results?.loading} onValueChange={value => {
            setUnitId(value ?? '')
            setResults(null)
          }} />
        <Button type="submit" disabled={!buildingId || results?.loading}>
          {results?.loading ? 'Searching…' : 'Search'}
        </Button>
      </form>

      {buildings.error && <p className="error" role="alert">{buildings.error}</p>}
      {buildings.data?.length === 0 && <p role="status">No buildings found.</p>}
      {results?.error && <p className="error" role="alert">{results.error}</p>}
      {results?.loading && <LoadingStatus className="feedback">Searching inventory…</LoadingStatus>}
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

function RecordFieldEditor({ name, editText, date, recordUrl, onSave, onCancel }) {
  const adding = name === undefined
  const isDate = typeof date === 'string'
  const [draftName, setDraftName] = useState('')
  const [draft, setDraft] = useState(editText ?? '')
  const [calendarOpen, setCalendarOpen] = useState(false)
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
    const text = isDate ? new FormData(event.currentTarget).get('calendarDate') : draft
    setSaving(true)
    setError(null)
    try {
      const field = await request(recordUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: fieldName,
          original: editText ?? null,
          text,
          ...(isDate && { calendarDate: true }),
        }),
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
      if (event.key === 'Escape' && !event.defaultPrevented && !calendarOpen && !saving) onCancel()
    }}>
      {adding && (
        <Field>
          <FieldLabel className="visually-hidden">Attribute name</FieldLabel>
          <Input placeholder="Attribute name" value={draftName}
            autoFocus required readOnly={saving} onValueChange={setDraftName} />
        </Field>
      )}
      <div className="field-editor field-editor-active">
        <Field>
          <FieldLabel className="visually-hidden">{adding ? 'Attribute value' : `Edit ${name}`}</FieldLabel>
          {isDate ? (
            <DatePicker name="calendarDate" defaultValue={date} required disabled={saving}
              timeZone="America/New_York" open={calendarOpen} onOpenChange={setCalendarOpen}>
              <DatePickerInput autoFocus />
              <DatePickerTrigger aria-label={`Choose date for ${name}`} />
              <DatePickerContent sideOffset={4} />
            </DatePicker>
          ) : (
            <Textarea placeholder={adding ? 'Attribute value' : undefined} value={draft}
              rows={editText?.includes('\n') ? 5 : 1} autoFocus={!adding} readOnly={saving}
              onValueChange={setDraft} />
          )}
        </Field>
        <div className="field-actions">
          <Button type="button" className="field-cancel"
            aria-label={adding ? 'Cancel adding attribute' : `Cancel editing ${name}`}
            disabled={saving} onClick={onCancel}>Cancel</Button>
          <Button type="submit" className="field-save" aria-label={adding ? 'Save new attribute' : `Save ${name}`}
            disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </form>
  )
}

function AttributeButton({ label, className, disabled, onClick, children }) {
  return (
    <Tooltip type="label">
      <TooltipTrigger render={<Button className={className} disabled={disabled} onClick={onClick} />}>
        <span aria-hidden="true">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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
            <AttributeButton className="field-edit" label={`Edit ${name}`} onClick={onEdit}>✎</AttributeButton>
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
      {loading && <LoadingStatus>Loading related records…</LoadingStatus>}
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
      <Button className="back" render={<a href="/" />}>Browse inventory</Button>
      <section className="intro">
        <h1>{data ? (savedFields.description?.value ?? data.description ?? query.get('id')) : 'Record details'}</h1>
        {collection && <p>{collection}</p>}
      </section>
      {loading && <LoadingStatus>Loading record…</LoadingStatus>}
      {error && <p className="error" role="alert">{error}</p>}
      {data && (
        <>
          <div className="fields-toolbar">
            <AttributeButton className="field-add" label="Add attribute"
              disabled={editingField !== null} onClick={() => setEditingField(newAttribute)}>+</AttributeButton>
          </div>
          <div className="panel">
            <ScrollableRows as="dl" label="Record fields" className="fields" visibleRowLimit={10}>
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
                        date={saved ? saved.date : record.dateFields?.[name]}
                        onSave={saveField} onCancel={cancelEdit} />
                    ) : null}
                  </RecordField>
                )
              })}
            </ScrollableRows>
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

function ContactsPage() {
  const { data: contacts, error, loading } = useResource('/api/contacts')
  const [nameQuery, setNameQuery] = useState('')
  const [selectedRole, setSelectedRole] = useState('')
  const roles = [...new Set((contacts ?? []).flatMap(contact => contact.roles ?? []))]
    .filter(role => typeof role === 'string' && role.trim())
    .sort((a, b) => a.localeCompare(b))
  const roleOptions = [
    { value: '', label: 'All roles' },
    ...roles.map(role => ({ value: role, label: role })),
  ]
  const matchingContacts = (contacts ?? []).filter(contact => {
    const name = contact.name || contact.description || contact.id
    return name.toLocaleLowerCase().includes(nameQuery.trim().toLocaleLowerCase()) &&
      (!selectedRole || (contact.roles ?? []).includes(selectedRole))
  })

  return (
    <>
      <section className="intro"><h1>Contacts</h1></section>
      <div className="panel contact-filters">
        <Field>
          <FieldLabel>Contact name</FieldLabel>
          <Input type="search" placeholder="Search names" value={nameQuery} onValueChange={setNameQuery} />
        </Field>
        <PropertySelect label="Contact role" value={selectedRole} items={roleOptions}
          disabled={loading || !!error} onValueChange={value => setSelectedRole(value ?? '')} />
      </div>
      {loading && <LoadingStatus>Loading contacts…</LoadingStatus>}
      {error && <p role="alert" className="error">{error}</p>}
      {contacts && (
        <>
          <p role="status">{matchingContacts.length} {matchingContacts.length === 1 ? 'contact' : 'contacts'}</p>
          <div className="panel contact-table-scroll" role="region" aria-label="Contacts table" tabIndex={0}>
            <table className="contact-table">
              <caption className="visually-hidden">Contacts matching name and role filters</caption>
              <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Organization</th><th scope="col">Email</th><th scope="col">Phone</th></tr></thead>
              <tbody>
                {matchingContacts.map(contact => (
                  <tr key={contact.bsonId ?? contact.id}>
                    <th scope="row">
                      <a className="contact-name" href={recordHref('contacts', contact)}>
                        {contact.name || contact.description || contact.id}
                      </a>
                    </th>
                    <td>{contact.roles?.join(', ') || '—'}</td>
                    <td>{contact.organization || '—'}</td>
                    <td>{contact.email ? <a href={`mailto:${contact.email}`}>{contact.email}</a> : '—'}</td>
                    <td>{contact.phone ? (
                      <a href={`tel:${contact.phone}${contact.extension ? `;ext=${contact.extension}` : ''}`}>
                        {contact.phone}{contact.extension && ` ext. ${contact.extension}`}
                      </a>
                    ) : '—'}</td>
                  </tr>
                ))}
                {matchingContacts.length === 0 && (
                  <tr><td colSpan={5}>{contacts.length ? 'No contacts match these filters.' : 'No contacts found.'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}

const pathname = window.location.pathname.replace(/\/$/, '') || '/'
const page = pathname === '/contacts' ? <ContactsPage /> : pathname === '/record' ? <RecordPage /> : <SearchPage />

function Navigation() {
  return (
    <Drawer side="left" preventEdgeSwipe>
      <DrawerTrigger className="nav-trigger" aria-label="Open navigation">
        <span aria-hidden="true"><i /><i /><i /></span>
      </DrawerTrigger>
      <DrawerBackdrop />
      <DrawerContent className="nav-drawer">
        <div className="nav-heading">
          <DrawerTitle>Navigation</DrawerTitle>
          <DrawerClose aria-label="Close navigation">×</DrawerClose>
        </div>
        <nav aria-label="Main navigation">
          <a href="/" aria-current={pathname === '/' ? 'page' : undefined}>Building search</a>
          <a href="/contacts" aria-current={pathname === '/contacts' ? 'page' : undefined}>Contacts</a>
        </nav>
      </DrawerContent>
    </Drawer>
  )
}

createRoot(document.getElementById('root')).render(
  <>
    <header>
      <div className="shell site-bar">
        <Navigation />
        <Button className="brand" render={<a href="/" />}><Mark />Property Inventory</Button>
      </div>
    </header>
    <main className="shell">
      {renderBuild ? (
        <Suspense fallback={<LoadingStatus>Loading sign-in…</LoadingStatus>}>
          <FirebaseAccess>{page}</FirebaseAccess>
        </Suspense>
      ) : page}
    </main>
  </>,
)
