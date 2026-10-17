// Shared by lifecycle settlement and account-maintenance checkpoints. An
// accepted reply remains mutable until text, files and any failure notice settle.
export function teamReplyDeliverySettled(reply) {
  const text = !reply.text || Boolean(reply.textSlackTs)
  const files = !reply.files?.length || ['none', 'uploaded'].includes(reply.fileDeliveryStatus) ||
    (reply.fileDeliveryStatus === 'failed' && Boolean(reply.fileDeliveryNotifiedAt))
  return text && files
}
