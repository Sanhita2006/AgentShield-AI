import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../server/db/database.ts';
import { exportAuditAnchor, verifyAuditAgainstAnchor, type ExternalAuditAnchor } from '../server/gateway/stage5_audit.ts';

dotenv.config();

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

const verifyFile = getArg('--verify');
const outFile = getArg('--out');

const db = getDb();

if (verifyFile) {
  const raw = fs.readFileSync(path.resolve(verifyFile), 'utf8');
  const anchor = JSON.parse(raw) as ExternalAuditAnchor;
  const result = verifyAuditAgainstAnchor(db, anchor);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.valid ? 0 : 1);
} else {
  const anchor = exportAuditAnchor(db);
  const json = JSON.stringify(anchor, null, 2);
  if (outFile) {
    const dest = path.resolve(outFile);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, json + '\n', 'utf8');
    console.error(`Wrote signed audit anchor (${anchor.entryCount} entries, head ${anchor.lastHash.slice(0, 12)}...) to ${dest}`);
  } else {
    console.log(json);
  }
}
