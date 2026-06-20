import { z } from 'zod'

export const listConversationsSchema = z.object({
  status: z.enum(['OPEN', 'PENDING', 'RESOLVED', 'ARCHIVED']).optional(),
  search: z.string().optional(),
  assignedTo: z.string().uuid().optional(),
  unreadOnly: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(30),
})

export const sendMessageSchema = z.object({
  body: z.string().min(1).optional(),
  contentType: z.enum(['TEXT', 'IMAGE', 'DOCUMENT', 'AUDIO', 'VIDEO', 'TEMPLATE', 'INTERACTIVE']).default('TEXT'),
  templateName: z.string().optional(),
  templateData: z.record(z.unknown()).optional(),
  mediaUrl: z.string().url().optional(),
  autoTranslate: z.boolean().optional(),
  clientMsgId: z.string().optional(),
})

export type ListConversationsQuery = z.infer<typeof listConversationsSchema>
export type SendMessageBody = z.infer<typeof sendMessageSchema>
