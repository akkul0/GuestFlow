import { z } from 'zod'

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  // Biri yeterli: eski panel otel kimliğini, yeni panel giriş adresindeki kısa adı gönderir
  hotelId: z.string().uuid().optional(),
  hotelSlug: z.string().min(1).optional(),
})

export const refreshTokenSchema = z.object({
  refreshToken: z.string().uuid(),
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10),
})

export type LoginBody = z.infer<typeof loginSchema>
export type RefreshTokenBody = z.infer<typeof refreshTokenSchema>
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>
