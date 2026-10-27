// Fills email templates for a lead.
//   Tokens:  {{name}} {{category}} {{suburb}} {{state}} {{rating}} {{reviewCount}} {{sender}}
//   Spintax: {Hey|Hi|G'day} picks one at random per email, so 210 emails a
//            day aren't 210 identical copies (identical copy is a spam signal).

export const TOKENS = ['name', 'category', 'suburb', 'state', 'rating', 'reviewCount', 'sender']

const STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']
export const STATE_TZ = {
  SA: 'Australia/Adelaide', NT: 'Australia/Darwin', WA: 'Australia/Perth', QLD: 'Australia/Brisbane',
  NSW: 'Australia/Sydney', ACT: 'Australia/Sydney', VIC: 'Australia/Melbourne', TAS: 'Australia/Hobart',
}

export function leadState(lead) {
  const a = String(lead?.address || '').toUpperCase()
  return STATES.find(s => new RegExp(`\\b${s}\\b`).test(a)) || null
}

export function leadSuburb(lead) {
  const parts = String(lead?.address || '').split(',').map(s => s.trim())
  const withState = parts.find(p => STATES.some(s => new RegExp(`\\b${s}\\b\\s*\\d{0,4}$`).test(p.toUpperCase())))
  if (withState) return withState.replace(/\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b.*$/i, '').trim()
  return parts.length >= 3 ? parts[parts.length - 2].replace(/\d{4}$/, '').trim() : ''
}

// "Smith's Plumbing Pty Ltd" → "Smith's Plumbing"
export function cleanBusinessName(name = '') {
  return String(name)
    .replace(/\s*\b(pty\.?\s*ltd\.?|pty|ltd\.?|limited|p\/l)\b\.?/gi, '')
    .replace(/\s*[-|–—]\s*(adelaide|melbourne|sydney|brisbane|perth|hobart|darwin|canberra).*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function spin(text = '') {
  let out = String(text)
  // Resolve innermost {a|b} groups first; {{tokens}} have no pipe so are left alone
  const re = /\{([^{}]*\|[^{}]*)\}/
  let guard = 0
  while (re.test(out) && guard++ < 200) {
    out = out.replace(re, (_, inner) => {
      const opts = inner.split('|')
      return opts[Math.floor(Math.random() * opts.length)]
    })
  }
  return out
}

export function render(text, lead = {}, ctx = {}) {
  const values = {
    name: cleanBusinessName(lead.name) || 'there',
    category: String(lead.category || 'business').toLowerCase(),
    suburb: leadSuburb(lead) || 'your area',
    state: leadState(lead) || '',
    rating: lead.rating ? String(lead.rating) : '',
    reviewCount: lead.reviewCount ? String(lead.reviewCount) : '',
    sender: String(ctx.fromName || 'Callum').split(' ')[0],
  }
  const filled = String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in values ? values[k] : m))
  return spin(filled).replace(/[ \t]+\n/g, '\n').trim()
}

// Is it currently inside the sending window where the LEAD is?
export function inWindow(settings, lead, now = new Date()) {
  const tz = (settings.leadLocalTime && STATE_TZ[leadState(lead)]) || 'Australia/Adelaide'
  return inWindowTz(settings, tz, now)
}

export function inWindowTz(settings, tz = 'Australia/Adelaide', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(now)
  const hour = Number(parts.find(p => p.type === 'hour')?.value) % 24
  const wd = parts.find(p => p.type === 'weekday')?.value
  if (settings.weekdaysOnly && (wd === 'Sat' || wd === 'Sun')) return false
  return hour >= settings.windowStart && hour < settings.windowEnd
}
