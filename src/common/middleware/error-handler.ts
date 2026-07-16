import { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  // Zod validation errors
  if (error instanceof ZodError) {
    return reply.status(422).send({
      statusCode: 422,
      error: 'Validation Error',
      message: 'Invalid request data',
      details: error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    })
  }

  // JWT errors
  if (error.code === 'FST_JWT_NO_AUTHORIZATION_IN_HEADER' || error.code === 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED') {
    return reply.status(401).send({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    })
  }

  // Rate limit
  if (error.statusCode === 429) {
    return reply.status(429).send({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please slow down.',
    })
  }

  // Bilinen HTTP hataları.
  // createError(...) ile üretilenler `expose` taşır → 5xx olsalar bile
  // (örn. 502: Meta/Outscraper reddi) sebep kullanıcıya gösterilir.
  const expose = (error as unknown as { expose?: boolean }).expose === true
  if (error.statusCode && (error.statusCode < 500 || expose)) {
    // Yukarı akış (upstream) hatalarını yine de logla — teşhis için gerekli
    if (error.statusCode >= 500) {
      request.log.error({ err: error, statusCode: error.statusCode }, 'Upstream error')
    }
    return reply.status(error.statusCode).send({
      statusCode: error.statusCode,
      error: error.name,
      message: error.message,
    })
  }

  // Unexpected server errors
  request.log.error({ err: error }, 'Unhandled server error')

  return reply.status(500).send({
    statusCode: 500,
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : error.message,
  })
}
