export function createError(
  statusCode: number,
  message: string,
): Error & { statusCode: number; expose: boolean } {
  const err = new Error(message) as Error & { statusCode: number; expose: boolean }
  err.statusCode = statusCode
  // Bu hatalar BİLEREK üretilir; mesajları geliştirici yazdığı için
  // kullanıcıya gösterilmesi güvenlidir. 5xx olsalar bile (örn. Meta'nın
  // reddi 502) sebebin gizlenmemesi gerekir — aksi halde "An unexpected
  // error occurred" çıkar ve sorun teşhis edilemez.
  err.expose = true
  return err
}
