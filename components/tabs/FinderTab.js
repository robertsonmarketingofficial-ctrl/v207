import { useMemo, useRef, useState } from 'react'
import { useStore, KEYS, set, updateLeads, newLead } from '../store'
import { enrollLeads } from '../engine'
import { hasBeenContacted } from '../tracker'
import { apiJSON } from '../api'
import { AU_STATES } from './helpers'
import { Spinner, Empty, toast, downloadFile, toCSV, CATEGORIES } from '../ui'

// Scrape websites a few at a time so we don't fire 200 requests at once.
async function scrapeAll(leads, onFound, onProgress, stopRef) {
  const queue = leads.filter(l => l.website && !l.email)
  let done = 0
  onProgress(0, queue.length)
  const worker = async () => {
    while (queue.length && !stopRef.current) {
      const lead = queue.shift()
      const d = await apiJSON('/api/scrape', { method: 'POST', body: { website: lead.website }, timeoutMs: 35000 })
      if (d.email) onFound(lead.id, d.email)
      onProgress(++done)
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
}

export default function FinderTab({ setTab }) {
  const [pipeline] = useStore(KEYS.pipeline)
  const [campaigns] = useStore(KEYS.campaigns)
  const [category, setCategory] = useState('Plumber')
  const [location, setLocation] = useState('')
  const [results, setResults] = useState([])
  const [busy, setBusy] = useState(null) // null | 'search' | 'sweep'
  const [sweep, setSweep] = useState({ done: 0, total: 0, current: '', state: '' })
  const [scrape, setScrape] = useState({ done: 0, total: 0 })
  const [error, setError] = useState('')
  const [emailOnly, setEmailOnly] = useState(true)
  const [hideHeld, setHideHeld] = useState(true)
  const [maxRating, setMaxRating] = useState(0)
  const [sel, setSel] = useState(new Set())
  const [campPick, setCampPick] = useState('')
  const stopRef = useRef(false)

  const held = useMemo(() => new Set(pipeline.map(l => l.id)), [pipeline])
  const shown = results.filter(l =>
    (!emailOnly || l.email) && (!hideHeld || !held.has(l.id)) && (!maxRating || (l.rating && l.rating < maxRating)))

  const found = (id, email) => setResults(rs => rs.map(r => r.id === id ? { ...r, email, contactedBefore: hasBeenContacted(email) } : r))
  const progress = (done, total) => setScrape(p => ({ done, total: total ?? p.total }))

  const runSearch = async (loc, pages, state) => {
    const d = await apiJSON('/api/search', { method: 'POST', body: { query: category, location: loc, maxPages: pages, state } })
    if (d.error) throw new Error(d.error)
    return (d.leads || []).map(l => ({ ...l, category }))
  }
  const logSearch = (where, n) => set(KEYS.searches, h => [{ category, location: where, count: n, date: new Date().toISOString() }, ...(h || [])].slice(0, 50))

  const search = async () => {
    if (!location.trim()) { setError('Type a suburb or city'); return }
    stopRef.current = false
    setBusy('search'); setError(''); setResults([]); setSel(new Set()); setScrape({ done: 0, total: 0 })
    try {
      const leads = await runSearch(location, 3)
      setResults(leads)
      logSearch(location, leads.length)
      setBusy(null)
      await scrapeAll(leads, found, progress, stopRef)
    } catch (e) { setError(e.message); setBusy(null) }
  }

  const stateSweep = async (state) => {
    stopRef.current = false
    setBusy('sweep'); setError(''); setResults([]); setSel(new Set()); setScrape({ done: 0, total: 0 })
    const seen = new Set()
    let all = []
    for (let i = 0; i < state.suburbs.length; i++) {
      if (stopRef.current) break
      const sub = state.suburbs[i]
      setSweep({ done: i, total: state.suburbs.length, current: sub, state: state.short })
      try {
        const leads = (await runSearch(sub, 3, state.short)).filter(l => !seen.has(l.id))
        leads.forEach(l => seen.add(l.id))
        all = [...all, ...leads]
        setResults(all)
      } catch (e) { if (i === 0) { setError(e.message); break } }
    }
    setSweep(s => ({ ...s, done: s.total, current: '' }))
    logSearch(state.label, all.length)
    setBusy(null)
    await scrapeAll(all, found, progress, stopRef)
  }

  const addSelected = (andCampaign) => {
    const picked = results.filter(l => sel.has(l.id))
    if (!picked.length) return
    const fresh = picked.filter(l => !held.has(l.id)).map(l => newLead(l))
    updateLeads(list => [...list, ...fresh])
    if (andCampaign) {
      const camp = campaigns.find(c => c.id === campPick) || campaigns[0]
      if (!camp) { toast('Create a campaign first'); setTab('campaigns'); return }
      const n = enrollLeads(picked.map(l => l.id), camp.id)
      toast(`${fresh.length} added to pipeline, ${n} queued in ${camp.name}`)
    } else {
      toast(`${fresh.length} added to pipeline${picked.length - fresh.length ? ` (${picked.length - fresh.length} already there)` : ''}`)
    }
    setSel(new Set())
  }

  const scraping = scrape.total > 0 && scrape.done < scrape.total
  const withEmail = results.filter(r => r.email).length
  const allOn = shown.length > 0 && shown.every(l => sel.has(l.id))

  return (
    <div className="stack">
      <div className="panel pad">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label style={{ flex: '1 1 200px' }}><span className="label">Trade</span>
            <input className="input" list="trade-list" value={category} onChange={e => setCategory(e.target.value)} placeholder="Roofer" />
            <datalist id="trade-list">{CATEGORIES.map(c => <option key={c} value={c} />)}</datalist>
          </label>
          <label style={{ flex: '2 1 260px' }}><span className="label">Suburb or city</span>
            <input className="input" value={location} onChange={e => setLocation(e.target.value)} onKeyDown={e => e.key === 'Enter' && !busy && search()} placeholder="Salisbury SA" disabled={!!busy} />
          </label>
          <button className="btn primary" style={{ height: 38 }} disabled={!!busy} onClick={search}>{busy === 'search' ? <Spinner size={14} /> : 'Search'}</button>
        </div>
        <hr className="sep" />
        <div className="row">
          <span className="small dim">Or sweep every suburb in a state:</span>
          {AU_STATES.map(s => <button key={s.short} className={`chip${sweep.state === s.short && busy === 'sweep' ? ' on' : ''}`} disabled={!!busy} onClick={() => stateSweep(s)}>{s.short}</button>)}
          {busy === 'sweep' && <button className="btn sm danger" style={{ marginLeft: 'auto' }} onClick={() => { stopRef.current = true }}>Stop</button>}
        </div>
        {busy === 'sweep' && (
          <div style={{ marginTop: 12 }}>
            <div className="row small dim" style={{ justifyContent: 'space-between' }}><span>Searching {sweep.current}</span><span className="num">{sweep.done}/{sweep.total} suburbs · {results.length} found</span></div>
            <div className="bar" style={{ marginTop: 6 }}><span className="c" style={{ width: `${sweep.total ? (sweep.done / sweep.total) * 100 : 0}%` }} /></div>
          </div>
        )}
        {error && <div className="small bad" style={{ marginTop: 10 }}>{error}</div>}
      </div>

      {results.length > 0 && (
        <div className="row">
          <span className="small dim num">{results.length} found · <b style={{ color: 'var(--text)' }}>{withEmail}</b> with an email · {results.filter(r => held.has(r.id)).length} already in pipeline</span>
          {scraping && <span className="small warn row" style={{ gap: 6 }}><Spinner size={12} /> Checking websites for emails {scrape.done}/{scrape.total}</span>}
          {!scraping && scrape.total > 0 && <span className="small ok">Done checking {scrape.total} websites</span>}
          <div className="grow" />
          <label className="row small dim" style={{ gap: 6 }}><input type="checkbox" checked={emailOnly} onChange={e => setEmailOnly(e.target.checked)} /> Only with email</label>
          <label className="row small dim" style={{ gap: 6 }}><input type="checkbox" checked={hideHeld} onChange={e => setHideHeld(e.target.checked)} /> Hide ones I have</label>
          <select className="select sm" value={maxRating} onChange={e => setMaxRating(Number(e.target.value))} aria-label="Rating"><option value={0}>Any rating</option><option value={4.5}>Below 4.5★</option><option value={4}>Below 4★</option><option value={3.5}>Below 3.5★</option></select>
          <button className="btn sm" onClick={() => downloadFile('finder-results.csv', toCSV(shown, [{ label: 'Name', key: 'name' }, { label: 'Email', key: 'email' }, { label: 'Website', key: 'website' }, { label: 'Rating', key: 'rating' }, { label: 'Reviews', key: 'reviewCount' }, { label: 'Address', key: 'address' }]), 'text/csv')}>Export</button>
        </div>
      )}

      <div className="panel">
        {busy === 'search' && <div className="empty"><Spinner size={26} /><div style={{ marginTop: 12 }}>Searching for {category.toLowerCase()}s in {location}…</div></div>}
        {!busy && !results.length && <Empty title="Search for a trade in a suburb" sub="Results get their websites checked for an email automatically. Only businesses with an email can go into a campaign." />}
        {results.length > 0 && !shown.length && !busy && <Empty title={scraping ? 'Still checking websites…' : 'Nothing matches these filters'} sub={scraping ? 'Emails appear as they’re found.' : 'Untick “Only with email” to see everything.'} />}
        {shown.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th style={{ width: 34 }}><input type="checkbox" checked={allOn} onChange={e => setSel(e.target.checked ? new Set(shown.map(l => l.id)) : new Set())} aria-label="Select all" /></th>
                <th>Business</th><th>Email</th><th>Rating</th><th>Website</th><th></th>
              </tr></thead>
              <tbody>
                {shown.map(l => (
                  <tr key={l.id} className={sel.has(l.id) ? 'sel' : ''}>
                    <td><input type="checkbox" checked={sel.has(l.id)} onChange={() => setSel(p => { const n = new Set(p); n.has(l.id) ? n.delete(l.id) : n.add(l.id); return n })} aria-label={`Select ${l.name}`} /></td>
                    <td><div style={{ fontWeight: 600 }}>{l.name}</div><div className="small muted">{l.address}</div></td>
                    <td className="small">{l.email ? <span className={l.contactedBefore ? 'muted' : 'dim'}>{l.email}{l.contactedBefore ? ' (emailed before)' : ''}</span> : l.website ? <span className="muted">{scraping ? 'checking…' : 'none on site'}</span> : <span className="muted">no website</span>}</td>
                    <td className={`small num ${l.rating && l.rating < 4 ? 'warn' : 'dim'}`}>{l.rating ? `${l.rating}★ (${l.reviewCount})` : '–'}</td>
                    <td className="small">{l.website ? <a href={l.website} target="_blank" rel="noreferrer">Open</a> : '–'}</td>
                    <td>{held.has(l.id) && <span className="tag">In pipeline</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {sel.size > 0 && (
        <div className="bulk">
          <b>{sel.size} selected</b>
          <button className="btn sm" onClick={() => addSelected(false)}>Add to pipeline</button>
          <span className="small muted">or</span>
          <select className="select sm" value={campPick} onChange={e => setCampPick(e.target.value)} aria-label="Campaign">
            {campaigns.length ? campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>) : <option value="">No campaigns yet</option>}
          </select>
          <button className="btn primary sm" onClick={() => addSelected(true)}>Add and queue in campaign</button>
          <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}
    </div>
  )
}
