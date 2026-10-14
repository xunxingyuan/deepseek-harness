import md5 from 'js-md5'
import { sm2 } from 'sm-crypto'

/** Encrypt a password digest for the legacy OAuth endpoint.
 * @param password - plaintext password, never persisted.
 * @param publicKey - G1brain SM2 public key.
 * @returns encrypted digest for the OAuth form.
 */
export function encryptG1Password(password: string, publicKey: string): string {
  if (!password) return ''
  return sm2.doEncrypt(md5(password), publicKey, 0)
}
