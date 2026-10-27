import { useEffect, useRef, useState } from 'react'
import { useStore, KEYS, updateLeads, newLead, get } from '../store'
import { enrollLeads } from '../engine'
import { hasBeenContacted } from '../tracker'
import { apiJSON } from '../api'
import { AU_STATES } from './helpers'
import { Spinner, Empty, Field, toast, CATEGORIES } from '../ui'

// "All of Australia" interleaves suburbs (SA #1, VIC #1, NSW #1, SA #2...)
// so a run that stops at its target isn't all from one state.
function interleaved() {
  const lists = AU_STATES.map(s => s.suburbs)
  const out = []
  for (let i = 0; i < Math.max(...lists.map(l => l.length)); i++) for (const l of lists) if (l[i]) out.push(l[i])
  return out
}
const TARGETS = [{ label: 'All of Australia', short: 'AUS', get suburbs() { return interleaved() } }, ...AU_STATES]
const SUBURB_STATE = {}
for (const s of AU_STATES) for (const sub of s.suburbs) SUBURB_STATE[sub] = s.short

export default function HunterTab({ setTab }) {
  const [campaigns] = useStore(KEYS.campaigns)
  const [niche, setNiche] = useState('Plumber')
  const [target, setTarget] = useState(1)
  const [goal, setGoal] = useState(200)
  const [maxRating, setMaxRating] = useState(0)
  const [campId, setCampId] = useState('')
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState([])
  const [t, setT] = useState({ suburbs: 0, checked: 0, emails: 0, queued: 0, skipped: 0 })
  const stopRef = useRef(false)
  const logRef = useRef(null)

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [log])
  useEffect(() => { if (!campId && campaigns[0]) setCampId(campaigns[0].id) }, [campaigns, campId])
  const add = (text, type = 'info') => setLog(l => [...l.slice(-300), { text, type, at: Date.now() }])

  const start = async () => {
    const camp = campaigns.find(c => c.id === campId)
    if (!camp) { toast('Pick a campaign for the leads to go into'); return }
    if (!niche.trim()) { toast('Type a trade'); return }
    stopRef.current = false
    setRunning(true); setLog([])
    const tally = { suburbs: 0, checked: 0, emails: 0, queued: 0, skipped: 0 }
    const bump = (k, n = 1) => { tally[k] += n; setT({ ...tally }) }
    setT({ ...tally })
    const region = TARGETS[target]
    const seen = new Set((get(KEYS.pipeline) || []).map(l => l.id))
    add(`Hunting ${niche.toLowerCase()}s in ${region.label}. Stops after ${goal} new leads with emails are queued in “${camp.name}”.`)

    for (const suburb of region.suburbs) {
      if (stopRef.current || tally.queued >= goal) break
      const d = await apiJSON('/api/afk-search', { method: 'POST', body: { niche, suburb, state: SUBURB_STATE[suburb] } })
      bump('suburbs')
      if (d.error) {
        add(`${suburb}: ${d.error}`, 'failed')
        if (/api key|not configured|PERMISSION|API_KEY/i.test(d.error)) break
        continue
      }
      const fresh = (d.leads || []).filter(l => !seen.has(l.id) && l.website && (!maxRating || (l.rating && l.rating < maxRating)))
      fresh.forEach(l => seen.add(l.id))
      if (!fresh.length) continue

      // Check websites 6 at a time
      const queue = [...fresh]
      const got = []
      await Promise.all(Array.from({ length: 6 }, async () => {
        while (queue.length && !stopRef.current) {
          const lead = queue.shift()
          const r = await apiJSON('/api/scrape', { method: 'POST', body: { website: lead.website }, timeoutMs: 35000 })
          bump('checked')
          if (!r.email) continue
          bump('emails')
          if (hasBeenContacted(r.email)) { bump('skipped'); continue }
          got.push({ ...lead, email: r.email, category: niche })
        }
      }))
      const room = Math.max(0, goal - tally.queued)
      const take = got.slice(0, room)
      if (take.length) {
        updateLeads(list => [...list, ...take.filter(l => !list.some(x => x.id === l.id)).map(l => newLead(l))])
        const n = enrollLeads(take.map(l => l.id), camp.id)
        bump('queued', n)
        add(`${suburb}: +${n} queued (${tally.queued}/${goal})`, 'sent')
      }
    }

    add(stopRef.current ? 'Stopped.' : tally.queued >= goal ? `Done. ${tally.queued} leads queued in “${camp.name}”.` : `Ran out of suburbs. ${tally.queued} leads queued.`, 'sent')
    if (camp.status !== 'running') add(`“${camp.name}” is paused. Start it in Campaigns to begin sending.`, 'warn')
    setRunning(false)
  }

  if (!campaigns.length) {
    return <div className="panel"><Empty title="Make a campaign first" sub="AFK Hunter drops every lead it finds straight into a campaign, so the sending engine can drip them out safely."><button className="btn primary" onClick={() => setTab('campaigns')}>Create a campaign</button></Empty></div>
  }

  return (
    <div className="stack">
      <div className="panel pad stack">
        <p className="small dim" style={{ margin: 0 }}>Searches suburb by suburb, checks each website for an email, skips anyone emailed before, and queues the rest in a campaign. It never sends directly. The engine sends them at your normal pace and caps.</p>
        <div className="grid3" style={{ gridTemplateColumns: '1.2fr 1fr 1.2fr .7fr .8fr' }}>
          <Field label="Trade"><input className="input" list="hunter-trades" value={niche} onChange={e => setNiche(e.target.value)} disabled={running} /><datalist id="hunter-trades">{CATEGORIES.map(c => <option key={c} value={c} />)}</datalist></Field>
          <Field label="Where"><select className="select" value={target} onChange={e => setTarget(Number(e.target.value))} disabled={running}>{TARGETS.map((s, i) => <option key={s.short} value={i}>{s.label}</option>)}</select></Field>
          <Field label="Into campaign"><select className="select" value={campId} onChange={e => setCampId(e.target.value)} disabled={running}>{campaigns.map(c => <option key={c.id} value={c.id}>{c.name}{c.status === 'running' ? '' : ' (paused)'}</option>)}</select></Field>
          <Field label="Stop after"><input className="input num" type="number" min={10} max={3000} value={goal} onChange={e => setGoal(Math.max(1, Number(e.target.value) || 1))} disabled={running} /></Field>
          <Field label="Rating"><select className="select" value={maxRating} onChange={e => setMaxRating(Number(e.target.value))} disabled={running}><option value={0}>Any</option><option value={4.5}>Below 4.5★</option><option value={4}>Below 4★</option></select></Field>
        </div>
        <div className="row">
          {!running ? <button className="btn primary" onClick={start}>Start hunting</button> : <button className="btn danger" onClick={() => { stopRef.current = true }}>Stop</button>}
          {running && <span className="small dim row" style={{ gap: 6 }}><Spinner size={12} /> Running. Keep this tab open.</span>}
        </div>
      </div>

      <div className="grid3" style={{ gridTemplateColumns: 'repeat(5, minmax(0,1fr))' }}>
        {[['Suburbs searched', t.suburbs], ['Websites checked', t.checked], ['Emails found', t.emails], ['Emailed before', t.skipped], ['Queued', t.queued]].map(([l, v]) => (
          <div key={l} className="panel stat"><div className={`stat-v ${l === 'Queued' ? 'bolt' : ''}`}>{v}</div><div className="stat-l">{l}</div></div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-head"><div className="panel-title">Run log</div></div>
        <div className="log" ref={logRef}>
          {!log.length && <div className="muted">Nothing yet.</div>}
          {log.map((l, i) => <div key={i} className="log-line"><span className="log-at">{new Date(l.at).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span><span className={l.type === 'sent' ? 'ok' : l.type === 'failed' ? 'bad' : l.type === 'warn' ? 'warn' : 'dim'}>{l.text}</span></div>)}
        </div>
      </div>
    </div>
  )
}
