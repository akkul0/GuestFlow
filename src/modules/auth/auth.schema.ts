import { z } from 'zod'

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  hotelId: z.string().uuid(),
})

export const refreshTokenSchema = z.object({
  refreshToken: z.string().uuid(),
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
    'Password must contain uppercase, lowercase, and a number',
  ),
})

export type LoginBody = z.infer<typeof loginSchema>
export type RefreshTokenBody = z.infer<typeof refreshTokenSchema>
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>
