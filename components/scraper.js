// Server-side only — finds a business email on its own website.
// mailto links first, then obfuscated addresses, then contact/about pages.

export async function scrapeEmail(website) {
  if (!website) return null
  let parsed
  try {
    parsed = new URL(website)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
  } catch { return null }

  // Social-only pages can't be scraped for a contact address this way.
  const host = parsed.hostname.toLowerCase()
  if (['facebook.com','www.facebook.com','instagram.com','www.instagram.com','linkedin.com','www.linkedin.com','tiktok.com','youtube.com']
      .some(h => host === h || host.endsWith('.' + h))) return null

  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g

  const isJunk = (e) => {
    const l = e.toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return true
    const junk = ['noreply','no-reply','donotreply','do-not-reply','example.','test@','sentry.','wixpress.',
      'schema.org','w3.org','wordpress.','shopify.','squarespace.','cloudflare.','godaddy.','.png','.jpg','.jpeg',
      '.gif','.svg','.webp','.js','.css','@2x','sentry-next','yourdomain','domain.com','email.com','user@']
    return junk.some(j => l.includes(j))
  }

  // Prefer a real business inbox over a random staff/webmaster address.
  const rank = (e) => {
    const l = e.toLowerCase()
    if (/^(info|enquiries|enquiry|contact|admin|office|hello|sales|bookings|quotes)@/.test(l)) return 0
    if (/^(accounts|support|service|mail)@/.test(l)) return 1
    if (/(webmaster|postmaster|hostmaster|abuse)@/.test(l)) return 3
    return 2
  }

  const extract = (html) => {
    const found = new Set()

    // mailto: links are the most reliable signal — check them first.
    for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
      const e = decodeURIComponent(m[1]).trim()
      if (e && !isJunk(e)) found.add(e)
    }

    // Decode common HTML entity obfuscation (&#64; / &commat; for @)
    const decoded = html
      .replace(/&#0*64;|&#x0*40;|&commat;/gi, '@')
      .replace(/&#0*46;|&#x0*2e;|&period;/gi, '.')

    for (const e of (decoded.match(emailRegex) || [])) {
      if (!isJunk(e)) found.add(e.trim())
    }

    // Text obfuscation: "info [at] example [dot] com" / "info (at) example.com"
    for (const m of decoded.matchAll(/([a-zA-Z0-9._%+\-]+)\s*[\[\(]\s*(?:at|@)\s*[\]\)]\s*([a-zA-Z0-9.\-]+)\s*(?:[\[\(]\s*(?:dot|\.)\s*[\]\)]\s*([a-zA-Z]{2,}))?/gi)) {
      const e = m[3] ? `${m[1]}@${m[2]}.${m[3]}` : `${m[1]}@${m[2]}`
      if (!isJunk(e)) found.add(e)
    }

    return Array.from(found)
  }

  const fetchPage = async (url, timeoutMs = 10000) => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-AU,en;q=0.9',
        },
      })
      clearTimeout(t)
      if (!r.ok) return ''
      return await r.text()
    } catch { clearTimeout(t); return '' }
  }

  const best = (emails) => emails.length ? emails.sort((a, b) => rank(a) - rank(b))[0] : null

  // 1. Homepage
  const homeHtml = await fetchPage(website)
  const fromHome = extract(homeHtml)
  if (fromHome.length) return best(fromHome)

  // 2. Follow contact-ish links actually present on the homepage, rather than
  //    only guessing at fixed paths.
  const linked = new Set()
  if (homeHtml) {
    for (const m of homeHtml.matchAll(/href=["']([^"']+)["']/gi)) {
      const href = m[1]
      if (/contact|about|enquir|quote|get-in-touch|reach-us/i.test(href)) {
        try { linked.add(new URL(href, parsed.origin).href) } catch {}
      }
      if (linked.size >= 5) break
    }
  }

  const guesses = ['/contact', '/contact-us', '/contact.html', '/contact-us.html', '/about',
                   '/about-us', '/get-a-quote', '/enquiry', '/contacts']
    .map(p => `${parsed.origin}${p}`)

  // Check discovered links first, then common guesses — in parallel batches
  // so one slow page doesn't stall everything.
  const candidates = [...linked, ...guesses].slice(0, 10)
  for (let i = 0; i < candidates.length; i += 4) {
    const batch = candidates.slice(i, i + 4)
    const pages = await Promise.all(batch.map(u => fetchPage(u, 8000)))
    const emails = pages.flatMap(extract)
    if (emails.length) return best(emails)
  }

  return null
}
