function slackErrorCode(error) {
  return String(error?.data?.error || error?.code || 'slack_error')
}

export async function inviteAndResolveCollaborator({ channel, userId, invite, resolveUserName }) {
  let invitation = 'invited'
  try { await invite(channel, userId) }
  catch (error) {
    const code = slackErrorCode(error)
    if (code === 'already_in_channel') invitation = 'already_member'
    else {
      const actionable = new Error(`Slack could not invite ${userId} to ${channel} (${code}). Check channel membership and the conversations:write scope.`)
      actionable.code = code
      actionable.cause = error
      throw actionable
    }
  }
  const name = await resolveUserName(userId)
  return { userId, name: String(name || userId), invitation }
}

export async function inviteAndWhitelistCollaborator({
  state, channel, userId, invite, resolveUserName, persist,
}) {
  const result = await inviteAndResolveCollaborator({ channel, userId, invite, resolveUserName })
  if (!state.whitelist) state.whitelist = {}
  state.whitelist[channel] = { ...(state.whitelist[channel] || {}), [userId]: result.name }
  persist()
  return result
}
