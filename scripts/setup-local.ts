import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hashPassword } from '../apps/api/src/auth.ts';

const credentials = JSON.parse(readFileSync('broker/secrets/test-credentials.json', 'utf8')) as Record<string, string>;
if (!credentials.backend) throw new Error('Run python3 broker/init_secrets.py first');
if (existsSync('.env') || existsSync('broker/secrets/operator-password.txt'))
  throw new Error('Local settings already exist; refusing to overwrite credentials');
const password = randomBytes(18).toString('base64url');
const env = `OPERATOR_PASSWORD_HASH=${hashPassword(password)}\nMQTT_USER=backend\nMQTT_PASSWORD=${credentials.backend}\nMQTT_URL=mqtt://127.0.0.1:1883\nAPP_ORIGIN=http://127.0.0.1:3000\nSQLITE_PATH=../../data/demo.sqlite\n`;
writeFileSync('.env', env, { mode: 0o600, flag: 'wx' });
writeFileSync('broker/secrets/operator-password.txt', `${password}\n`, { mode: 0o600, flag: 'wx' });
console.log('Local API settings and an operator password were created in ignored files.');
