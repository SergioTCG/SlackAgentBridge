import { validateNodeId } from './nodes.mjs'

export class NodeManagementError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'NodeManagementError'
    this.code = code
    this.status = status
  }
}

function exactObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NodeManagementError(`invalid_${label}`, `${label} must be a JSON object`)
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new NodeManagementError(`invalid_${label}`, `unknown ${label} field: ${field}`)
  }
  return value
}

export function createNodeManagement({
  coordinatorId,
  adminUserId,
  registry,
  invitations,
  transport,
  resolveOperator = async userId => ({ id: userId }),
  listenerStatus = () => ({ enabled: false }),
} = {}) {
  if (!registry || !invitations || !transport) throw new Error('node management requires registry, invitations, and transport')

  async function issueInvitation(input) {
    const value = exactObject(input, new Set(['operatorId', 'name', 'ttlSeconds']), 'invitation')
    const listener = listenerStatus()
    if (!listener?.enabled || !listener.publicUrl) {
      throw new NodeManagementError(
        'node_listener_disabled',
        'remote node enrollment is disabled; configure SAB_NODE_LISTEN and restart the coordinator first',
        409,
      )
    }
    const operatorId = String(value.operatorId || '')
    try { await resolveOperator(operatorId) }
    catch (error) {
      throw new NodeManagementError(
        'operator_unavailable',
        `Slack user ${operatorId || '(missing)'} is not an available member of this workspace (${error?.code || error?.message || 'lookup failed'})`,
      )
    }
    let ttlMs
    if (value.ttlSeconds !== undefined) {
      if (!Number.isSafeInteger(value.ttlSeconds) || value.ttlSeconds < 1 || value.ttlSeconds > 3600) {
        throw new NodeManagementError('invalid_invitation_ttl', 'ttlSeconds must be an integer from 1 through 3600')
      }
      ttlMs = value.ttlSeconds * 1000
    }
    try {
      return {
        ...invitations.issue({ operatorId, name: value.name, ...(ttlMs === undefined ? {} : { ttlMs }) }),
        coordinatorUrl: listener.publicUrl,
      }
    } catch (error) {
      throw new NodeManagementError('invitation_rejected', String(error?.message || error))
    }
  }

  function status() {
    return {
      coordinatorId,
      listener: listenerStatus(),
      nodes: registry.listFor(adminUserId),
      invitations: invitations.list(),
      connections: transport.connections(),
    }
  }

  async function revoke(requestedNodeId) {
    let nodeId
    try { nodeId = validateNodeId(requestedNodeId) }
    catch (error) { throw new NodeManagementError('invalid_node_id', error.message) }
    if (nodeId === 'local') throw new NodeManagementError('local_node_immutable', 'the implicit local node cannot be revoked')
    const existing = registry.record(nodeId)
    const pending = invitations.list().some(invitation => invitation.nodeId === nodeId)
    if (!existing && !pending) throw new NodeManagementError('node_not_found', `execution node not found: ${nodeId}`, 404)
    // Persist invalidation before closing the socket. A crash may leave an
    // already-revoked connection open briefly, but it can never reconnect or
    // win a later epoch with its now-invalid key.
    if (existing) registry.revoke(nodeId)
    const invitationsRevoked = invitations.revoke(nodeId)
    const disconnected = transport.disconnect(nodeId, 'node_revoked')
    return { nodeId, revoked: true, disconnected, invitationsRevoked }
  }

  return Object.freeze({ issueInvitation, revoke, status })
}
