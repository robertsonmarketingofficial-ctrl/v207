import { useState } from 'react'
import { useStore, KEYS, set, get, DEFAULT_SETTINGS } from '../store'
import { verifyLogins } from '../engine'
import { contactedCount, exportContacted, importContacted, clearContacted } from '../tracker'
import { apiJSON } from '../api'
import { Field, Spinner, toast, downloadFile } from '../ui'

const hourLabel = (h) => h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`

export default function SettingsTab() {
  const [s] = useStore(KEYS.settings)
  const [pipeline] = useStore(KEYS.pipeline)
  const [contacted, setContacted] = useState(contactedCount())
  const [logins, setLogins] = useState(null)
  const [checking, setChecking] = useState(false)
  const [places, setPlaces] = useState(null)
  const setS = (patch) => set(KEYS.settings, x => ({ ...x, ...patch }))

  const checkLogins = async () => { setChecking(true); setLogins(await verifyLogins()); setChecking(false) }
  const checkPlaces = async () => { setPlaces({ loading: true }); setPlaces((await apiJSON('/api/test-keys')).places || { status: 'error', error: 'No response' }) }

  const backup = () => {
    const data = {
      version: 205, at: new Date().toISOString(),
      pipeline: get(KEYS.pipeline), campaigns: get(KEYS.campaigns), settings: get(KEYS.settings),
      accounts: get(KEYS.accounts), inbox: get(KEYS.inbox), contacted: exportContacted(),
    }
    downloadFile(`robertson-crm-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data))
    toast(`Backed up ${data.pipeline.length} leads and ${data.campaigns.length} campaigns`)
  }
  const restore = (e) => {
    const file = e.target.files?.[0]; if (!file) return
    const r = new FileReader()
    r.onload = () => {
      try {
        const d = JSON.parse(String(r.result))
        // Old backups were just the pipeline array
        const leads = Array.isArray(d) ? d : d.pipeline || []
        const ids = new Set(get(KEYS.pipeline).map(l => l.id))
        const added = leads.filter(l => l && l.id && !ids.has(l.id))
        set(KEYS.pipeline, list => [...list, ...added])
        if (!Array.isArray(d)) {
          if (d.campaigns) set(KEYS.campaigns, list => [...list, ...d.campaigns.filter(c => !list.some(x => x.id === c.id))])
          if (d.accounts) set(KEYS.accounts, m => ({ ...d.accounts, ...m }))
          if (d.contacted) setContacted(importContacted(d.contacted))
          if (d.inbox?.messages) set(KEYS.inbox, i => ({ ...i, messages: [...i.messages, ...d.inbox.messages.filter(m => !i.messages.some(x => x.id === m.id))] }))
        }
        toast(`Restored ${added.length} leads${Array.isArray(d) ? '' : ', plus campaigns and history'}`)
      } catch (err) { toast(`Restore failed: ${err.message}`) }
    }
    r.readAsText(file); e.target.value = ''
  }

  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <div className="panel pad stack">
        <div className="panel-title">Sending rules</div>
        <div className="grid3">
          <Field label="Default cold emails per inbox per day" hint="Used for any inbox without its own limit. Set each inbox's own limit when you start a campaign, or on the Inboxes tab."><input className="input num" type="number" min={1} max={150} value={s.perInboxCap} onChange={e => setS({ perInboxCap: Math.min(150, Math.max(1, Number(e.target.value) || 1)) })} /></Field>
          <Field label="Sending starts"><select className="select" value={s.windowStart} onChange={e => setS({ windowStart: Number(e.target.value) })}>{Array.from({ length: 13 }, (_, i) => i + 5).map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></Field>
          <Field label="Sending stops"><select className="select" value={s.windowEnd} onChange={e => setS({ windowEnd: Number(e.target.value) })}>{Array.from({ length: 13 }, (_, i) => i + 10).map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></Field>
          <Field label="Shortest gap between emails (seconds)"><input className="input num" type="number" min={1} value={s.minGapSec} onChange={e => setS({ minGapSec: Math.max(1, Number(e.target.value) || 1) })} /></Field>
          <Field label="Longest gap (seconds)"><input className="input num" type="number" min={1} value={s.maxGapSec} onChange={e => setS({ maxGapSec: Math.max(s.minGapSec, Number(e.target.value) || s.minGapSec) })} /></Field>
          <Field label="Your name on emails"><input className="input" value={s.fromName} onChange={e => setS({ fromName: e.target.value })} /></Field>
        </div>
        <label className="row small dim" style={{ gap: 8 }}><input type="checkbox" checked={s.weekdaysOnly} onChange={e => setS({ weekdaysOnly: e.target.checked })} /> Weekdays only</label>
        <label className="row small dim" style={{ gap: 8 }}><input type="checkbox" checked={s.leadLocalTime} onChange={e => setS({ leadLocalTime: e.target.checked })} /> Use the lead’s local time (a Perth lead gets emailed during Perth business hours)</label>
        <div className="small muted">
          At a {s.minGapSec}–{s.maxGapSec} second gap, a full day’s sends (6 inboxes × {s.perInboxCap} = {6 * s.perInboxCap}) go out in about {Math.max(1, Math.round((6 * s.perInboxCap * ((s.minGapSec + s.maxGapSec) / 2 + 2)) / 60))} minutes.
          {s.maxGapSec < 60 && <span className="warn"> Short gaps mean bursty sending, which Gmail watches for. Spreading sends across the day (60–180 seconds) is safer for inbox health.</span>}
        </div>
        <Field label="Check inboxes for replies every"><select className="select" style={{ maxWidth: 200 }} value={s.inboxSyncMins} onChange={e => setS({ inboxSyncMins: Number(e.target.value) })}>{[2, 5, 10, 15, 30].map(m => <option key={m} value={m}>{m} minutes</option>)}</select></Field>
        <div><button className="btn ghost sm" onClick={() => set(KEYS.settings, x => ({ ...DEFAULT_SETTINGS, engineOn: x.engineOn, fx: x.fx, fromName: x.fromName }))}>Reset sending rules to defaults</button></div>
      </div>

      <div className="panel pad stack">
        <div className="panel-title">Background</div>
        <div className="seg">{[['storm', 'Thunderstorm'], ['stars', 'Shooting stars'], ['off', 'Plain black']].map(([k, l]) => <button key={k} className={s.fx === k ? 'on' : ''} onClick={() => setS({ fx: k })}>{l}</button>)}</div>
      </div>

      <div className="panel pad stack">
        <div className="row"><div className="panel-title grow">Gmail connection</div><button className="btn sm" disabled={checking} onClick={checkLogins}>{checking ? <Spinner size={12} /> : 'Test logins'}</button></div>
        <div className="small dim">Inboxes come from two Vercel environment variables, comma-separated and in the same order: <b>GMAIL_USERS</b> and <b>GMAIL_APP_PASSWORDS</b>. Each Gmail needs 2-Step Verification on and a 16-letter App Password from myaccount.google.com/apppasswords. Redeploy after changing them. The same App Password is used to read replies over IMAP.</div>
        {logins && (logins.accountCount ? logins.accounts.map((a, i) => (
          <div key={a.user} className="row small"><span className={`tag ${a.ok ? 'ok' : 'bad'}`}>{a.ok ? 'Login OK' : 'Failed'}</span><b>{a.user}</b>{!a.ok && <span className="muted" style={{ flexBasis: '100%' }}>{a.error}</span>}{logins.passwordLengths?.[i] !== 16 && <span className="warn">Password is {logins.passwordLengths[i]} characters, App Passwords are 16.</span>}</div>
        )) : <div className="small bad">{logins.error || 'No Gmail inboxes are configured on the server.'}</div>)}
      </div>

      <div className="panel pad stack">
        <div className="row"><div className="panel-title grow">Google Places key</div><button className="btn sm" onClick={checkPlaces}>{places?.loading ? <Spinner size={12} /> : 'Test key'}</button></div>
        <div className="small dim">Used by Lead Finder and AFK Hunter. Set <b>GOOGLE_PLACES_API_KEY</b> in Vercel.</div>
        {places && !places.loading && <div className={`small ${places.status === 'working' ? 'ok' : 'bad'}`}>{places.status === 'working' ? 'Working' : places.error}</div>}
      </div>

      <div className="panel pad stack">
        <div className="panel-title">Backup</div>
        <div className="small dim">Everything lives in this browser only: {pipeline.length} leads, your campaigns, inbox history and the list of {contacted} addresses you’ve ever emailed. Clearing your browser or switching computers loses it unless you back up. One file covers all of it, and old pipeline backups still restore.</div>
        <div className="row">
          <button className="btn primary sm" onClick={backup}>Download backup</button>
          <label className="btn sm" style={{ cursor: 'pointer' }}>Restore from file<input type="file" accept=".json" onChange={restore} style={{ display: 'none' }} /></label>
        </div>
        <hr className="sep" />
        <div className="small dim">The emailed-before list stops anyone getting a first cold email twice, across every campaign and sweep.</div>
        <div><button className="btn danger sm" onClick={() => { if (confirm(`Forget all ${contacted} emailed-before addresses? The same businesses could then get cold emailed again.`)) { clearContacted(); setContacted(0); toast('Cleared') } }}>Clear emailed-before list</button></div>
      </div>
    </div>
  )
}
