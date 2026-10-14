/**
 * An invite is how a teammate gets their own remote address without touching Cloudflare: whoever runs
 * the company's Cloudflare (`npm run invite -- --email them@company.com`) makes one, sends it privately,
 * and the Mac app's "Phone & remote access" dialog turns it into remote.json plus a tunnel token.
 * It contains the tunnel's secret, so treat it like a password.
 */
export const INVITE_PREFIX = 'studio-invite:';

export type Invite = {
  v: 1;
  email: string;
  host: string;
  team: string;
  aud: string;
  allow: string[];
  shareAud: string;
  shareAllow: string[];
  tunnelToken: string;
};

const str = (x: unknown, re: RegExp) => typeof x === 'string' && re.test(x);

export function decodeInvite(code: string): Invite {
  const bad = () => new Error('That invite code isn’t valid. Copy the whole thing, starting with “studio-invite:”.');
  const raw = code.trim();
  if (!raw.startsWith(INVITE_PREFIX)) throw bad();
  let j: any;
  try {
    j = JSON.parse(Buffer.from(raw.slice(INVITE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  const okEmails = (a: unknown) => Array.isArray(a) && a.length > 0 && a.every((e) => str(e, /^@?[^@\s]+@?[^@\s]*$/));
  if (
    j?.v !== 1 ||
    !str(j.email, /^[^@\s]+@[^@\s]+\.[^@\s]+$/) ||
    !str(j.host, /^[a-z0-9.-]+\.[a-z]{2,}$/) ||
    !str(j.team, /^[a-z0-9-]+\.cloudflareaccess\.com$/) ||
    !str(j.aud, /^[\w-]{8,}$/) ||
    !str(j.shareAud, /^[\w-]{8,}$/) ||
    !okEmails(j.allow) ||
    !okEmails(j.shareAllow) ||
    !str(j.tunnelToken, /^[\w=.-]{20,}$/)
  )
    throw bad();
  const { v, email, host, team, aud, allow, shareAud, shareAllow, tunnelToken } = j;
  return { v, email, host, team, aud, allow, shareAud, shareAllow, tunnelToken };
}

export const encodeInvite = (i: Invite) => INVITE_PREFIX + Buffer.from(JSON.stringify(i)).toString('base64url');
