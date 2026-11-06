import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyReply, FastifyRequest } from 'fastify';

const sessionMs = 12 * 60 * 60 * 1000;
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')): string {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 2 || !/^[0-9a-f]{32}$/.test(parts[0]) || !/^[0-9a-f]{128}$/.test(parts[1])) return false;
  const actual = scryptSync(password, parts[0], 64);
  return timingSafeEqual(actual, Buffer.from(parts[1], 'hex'));
}

export function createSession(db: DatabaseSync, now: Date): { token: string; csrfToken: string } {
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO operator_sessions(token_hash,csrf_token,created_at,expires_at) VALUES(?,?,?,?)')
    .run(digest(token), csrfToken, now.toISOString(), new Date(now.getTime() + sessionMs).toISOString());
  return { token, csrfToken };
}

export function sessionForRequest(db: DatabaseSync, request: FastifyRequest, now: Date): { tokenHash: string; csrfToken: string } | null {
  const match = /(?:^|;\s*)session=([0-9a-f]{64})(?:;|$)/.exec(request.headers.cookie ?? '');
  if (!match) return null;
  const tokenHash = digest(match[1]);
  const row = db.prepare('SELECT csrf_token,expires_at FROM operator_sessions WHERE token_hash=?')
    .get(tokenHash) as { csrf_token: string; expires_at: string } | undefined;
  if (!row || Date.parse(row.expires_at) <= now.getTime()) return null;
  return { tokenHash, csrfToken: row.csrf_token };
}

export function requireSession(db: DatabaseSync, request: FastifyRequest, reply: FastifyReply, now: Date,
  origin: string, csrf = false): { tokenHash: string; csrfToken: string } | null {
  const session = sessionForRequest(db, request, now);
  if (!session) { reply.code(401).send({ code: 'UNAUTHENTICATED', message: 'ورود لازم است.' }); return null; }
  if (csrf && (request.headers.origin !== origin || request.headers['x-csrf-token'] !== session.csrfToken)) {
    reply.code(403).send({ code: 'CSRF_ORIGIN', message: 'درخواست تأیید نشد.' }); return null;
  }
  return session;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`;
}
