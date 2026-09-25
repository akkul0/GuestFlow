import pino from 'pino'
import { safeSerializers } from '../common/utils/log-safety'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  serializers: safeSerializers,
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
})
