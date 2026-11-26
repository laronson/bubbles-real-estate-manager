export function createGoogleGroupAccess(group, getAccessToken, fetchMembership = fetch) {
  if (!/^groups\/[a-zA-Z0-9_-]+$/.test(group)) {
    throw new Error('INVENTORY_GOOGLE_GROUP must be a Cloud Identity resource name in the form groups/GROUP_ID.')
  }

  return async email => {
    const { access_token: token } = await getAccessToken()
    const url = new URL(`https://cloudidentity.googleapis.com/v1/${group}/memberships:lookup`)
    url.searchParams.set('memberKey.id', email)

    const response = await fetchMembership(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    })
    if (response.status === 404) return false
    if (!response.ok) throw new Error(`Google group membership lookup returned HTTP ${response.status}.`)

    const { name } = await response.json()
    if (typeof name !== 'string' || !name.startsWith(`${group}/memberships/`)) {
      throw new Error('Google group membership lookup returned an invalid membership.')
    }
    return true
  }
}
