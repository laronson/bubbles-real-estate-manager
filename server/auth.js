export function requireInventoryAccess(verifyIdToken, getAllowedEmails) {
  return async (req, res, next) => {
    const token = /^Bearer (\S+)$/i.exec(req.get('authorization') ?? '')?.[1]
    if (!token) return res.status(401).json({ error: 'Sign in to access the inventory.' })

    let claims
    try {
      claims = await verifyIdToken(token)
    } catch {
      return res.status(401).json({ error: 'Your sign-in expired. Sign in again.' })
    }

    const allowlist = getAllowedEmails().toLowerCase().split(',').map(email => email.trim()).filter(Boolean)
    if (claims.firebase?.sign_in_provider !== 'google.com' || claims.email_verified !== true ||
        !allowlist.includes(claims.email?.toLowerCase())) {
      return res.status(403).json({ error: 'This Google account does not have inventory access.' })
    }
    next()
  }
}
