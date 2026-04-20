/** Base64url-encode a string for use as a Telegram Mini App `startapp` parameter. */
export function toBase64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
