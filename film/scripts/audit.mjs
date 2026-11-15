#!/usr/bin/env node
// The audit's numbers as the site has them now, kept for the film's last scene and its last line:
//   node scripts/audit.mjs   ->  src/data/audit3.json
// Run it again only when the voice is recorded again: the line says "almost nine hundred" and "nineteen".
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const film = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = await fetch((process.env.SOFTYES || 'https://soft-yes.fly.dev') + '/api/audit');
if (!r.ok) throw new Error(`audit ${r.status}`);
const d = await r.json();
const out = {claims: d.claims, confirmed: d.confirmed, corrected: d.corrected, unstated: d.unstated, unread: d.unread, at: new Date().toISOString()};
for (const k of ['claims', 'confirmed', 'corrected', 'unstated', 'unread']) if (typeof out[k] !== 'number') throw new Error(`the audit has no ${k}`);
fs.writeFileSync(path.join(film, 'src/data/audit3.json'), JSON.stringify(out, null, 1) + '\n');
console.log(out);
