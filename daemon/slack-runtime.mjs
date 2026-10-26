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
  // A call whose side effect cannot be repeated safely, such as creating a
  // channel, must not be retried by the client: a lost response has to
  // surface as an uncertain outcome, not as a later attempt's `name_taken`.
  const webOnce = new WebClientImpl(botToken, { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true })
  const socket = new SocketModeClientImpl({ appToken })
  return Object.freeze({ mode: 'all-in-one', web, webOnce, socket })
}
