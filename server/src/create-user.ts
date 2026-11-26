// Usage: npm run create-user -- <username> [viewer|operator|admin] [--no-2fa]   (prompts for a password; or set NEW_PASSWORD)
//        npm run create-user -- <username> --reset-2fa    (lockout escape: removes two-step sign-in, ends sessions, no password asked)
// The role defaults to viewer for a new user and is left unchanged for an existing one (existing users without a role stay admin).
// --no-2fa marks a service account (e.g. a link checker) as exempt from the second step; it only gets a session from loopback.
// Creates the user, or resets the password if it already exists. Users live in the SQLite database (DB_PATH).
import { createInterface } from 'node:readline';
import { hashPassword } from './auth.js';
import { closeDb, connectDb, resetUserMfa, upsertPasswordUser } from './db.js';
import { isRole } from './roles.js';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const pos = args.filter((a) => !a.startsWith('--'));
const username = (pos[0] ?? '').trim().toLowerCase();
const roleArg = pos[1];
const reset2fa = flags.includes('--reset-2fa');
const no2fa = flags.includes('--no-2fa');
const badFlag = flags.find((f) => f !== '--reset-2fa' && f !== '--no-2fa');
if (!username || badFlag) { console.error('Usage: npm run create-user -- <username> [viewer|operator|admin] [--no-2fa]\n       npm run create-user -- <username> --reset-2fa'); process.exit(1); }
if (roleArg !== undefined && !isRole(roleArg)) { console.error('Role must be viewer, operator or admin.'); process.exit(1); }

if (reset2fa) {
  connectDb();
  const r = resetUserMfa(username);
  if (!r.found) { console.error(`No user "${username}".`); closeDb(); process.exit(1); }
  console.log(`Two-step sign-in ${r.hadMfa ? 'removed' : 'was not enabled'} for "${username}"; ended ${r.sessions} session(s). Nothing else changed.`);
  closeDb();
  process.exit(0);
}

function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const w = (rl as unknown as { _writeToOutput: (s: string) => void });
  const orig = w._writeToOutput.bind(rl);
  w._writeToOutput = (s) => { if (s.includes(prompt)) orig(s); }; // hide typed characters
  return new Promise((res) => rl.question(prompt, (a) => { rl.close(); process.stdout.write('\n'); res(a); }));
}

const password = process.env.NEW_PASSWORD ?? (await ask('Password: '));
if (password.length < 12) { console.error('Password must be at least 12 characters.'); process.exit(1); }
if (!process.env.NEW_PASSWORD && (await ask('Repeat password: ')) !== password) { console.error('Passwords do not match.'); process.exit(1); }

connectDb();
const result = upsertPasswordUser(username, hashPassword(password), { role: roleArg, mfaExempt: no2fa });
console.log(result === 'created' ? `Created user "${username}" (${roleArg ?? 'viewer'}).` : `Updated password for "${username}" and ended its sessions.`);
closeDb();
