import { WebClient } from '@slack/web-api'
import { SocketModeClient } from '@slack/socket-mode'

// The direct runtime is today's all-in-one deployment. Remote execution nodes
// will receive a coordinator-backed Slack facade and never construct this
// runtime or receive either Slack token.
export function createDirectSlackRuntime({
  botToken,
  appToken,
  WebClientImpl = WebClient,
  SocketModeClientImpl = SocketModeClient,
}) {
  const web = new WebClientImpl(botToken)
  const socket = new SocketModeClientImpl({ appToken })
  return Object.freeze({ mode: 'all-in-one', web, socket })
}
