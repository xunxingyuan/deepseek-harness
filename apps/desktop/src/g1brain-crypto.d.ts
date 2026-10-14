/** Narrow signatures used by the G1brain OAuth password exchange. */
declare module 'js-md5' {
  const md5: (message: string) => string
  export default md5
}

declare module 'sm-crypto' {
  export const sm2: { doEncrypt(message: string, publicKey: string, cipherMode: 0 | 1): string }
}
