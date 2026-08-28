const SOCKET_EVENTS = ['message', 'slash_commands', 'interactive']

// Socket Mode belongs to the coordinator. Business handlers may currently be
// in-process (the compatibility deployment) or later route to an enrolled node;
// Slack delivery is acknowledged before either path performs slow work.
export function createSocketModeCoordinator({ socket, handlers = {}, onError = async () => {} }) {
  if (!socket || typeof socket.on !== 'function' || typeof socket.start !== 'function') {
    throw new Error('coordinator requires one Socket Mode client')
  }
  let bound = false
  let startPromise = null

  function bind() {
    if (bound) return
    bound = true
    for (const kind of SOCKET_EVENTS) {
      const handler = handlers[kind]
      if (typeof handler !== 'function') continue
      socket.on(kind, async packet => {
        try { await packet?.ack?.() } catch {}
        try { await handler(packet || {}) }
        catch (error) {
          try { await onError(kind, error, packet || {}) } catch {}
        }
      })
    }
  }

  function start() {
    bind()
    if (!startPromise) startPromise = Promise.resolve().then(() => socket.start())
    return startPromise
  }

  return Object.freeze({ start })
}
