#!/usr/bin/env node
// Voice-over and music bed for the film, via ElevenLabs. Spoken numbers are built from
// src/data/cap.json (what the capture read from the product), so they always match the screen.
// Writes <bulk>/public/audio/vo-NN.mp3 and src/data/vo.json (with word timings for the captions).
//
//   hsec exec --only ELEVENLABS_API_KEY -- node scripts/make-vo.mjs --music
//   node scripts/make-vo.mjs --print        # the narration, no key needed
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const film = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bulk = process.env.FILM_BULK || '/bulk2/runs/cala/film';
const A = process.argv.slice(2);
const C = JSON.parse(fs.readFileSync(path.join(film, 'src/data/cap.json'), 'utf8'));

const ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const words = (n) => {
	n = Math.round(n);
	if (n < 20) return ONES[n];
	if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
	if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' and ' + words(n % 100) : '');
	return String(n);
};
const cap = (t) => t[0].toUpperCase() + t.slice(1);
const need = (v, what) => {
	if (v === null || v === undefined) throw new Error(`cap.json has no ${what}: record the shots first`);
	return v;
};

const W = need(C.walk?.facts, 'walk');
const K = need(C.check?.facts, 'check');
const L = need(C.lead?.facts, 'lead');
const Q = need(C.ask?.facts, 'ask');
const U = need(C.audit?.facts, 'audit');
const N = need(C.next?.facts, 'next');
const tally = W.tally;
if (tally['from a language model'] !== 0) throw new Error('the page no longer shows 0 facts from a language model: rewrite the narration');
if (K.held !== 1 || K.finds.length !== 2 || L.company === K.finds[0].company) throw new Error('the story is "three claimed, one holds, two do not"; the walk no longer says that: rewrite the narration');

const span = (months) => (months % 12 === 0 ? `${months === 12 ? 'year' : words(months / 12) + ' years'}` : `${words(months)} months`);
const say = (name) => name.replace(/\.(io|ai|com|vc)$/i, ''); // a name as it is spoken
const first = (name) => name.split(' ')[0];
// "next week" only if Slush really starts in the calendar week after the capture
const slushWhen = () => {
	const s = N.slush;
	const start = new Date(s.starts + 'T12:00:00Z');
	const today = new Date(start.getTime() - s.days_away * 864e5);
	const monday = (d) => Math.floor((d.getTime() / 864e5 + 3) / 7); // weeks since a Monday
	const dw = monday(start) - monday(today);
	if (s.days_away < 0) throw new Error('Slush is over: rewrite the Slush line');
	return dw === 0 ? 'this week' : dw === 1 ? 'next week' : `in ${words(s.days_away)} days`;
};
const [f0, f1] = K.finds;
const own = (f) => f.publisher.toLowerCase().includes(say(f.company).toLowerCase().replace(/[^a-z0-9]/g, ''));
const me = W.soft[0];

// [scene, pause before the line in seconds (from the scene start for a scene's first line), text]
const LINES = [
	// the first sentence names the founder, the soft yes and a number from the page; the count of all rounds is said
	// only if the page shows the same one while the walk draws and when it is done
	[
		'open',
		0.15,
		`You're raising a round, and ${me} says we're in if you find a lead, but in Cala, ${me} led only ` +
			(W.node.rounds === W.node.rounds_done ? `${words(W.node.led)} of its ${words(W.node.rounds)} rounds.` : `${words(W.node.led)} ${W.node.led === 1 ? 'round' : 'rounds'} itself.`),
	],
	['open', 0.3, 'So who led the others?'],
	['open', 0.3, "Soft Yes walks Cala's graph: the rounds your investors joined, and who led them."],
	['open', 0.3, `${cap(words(W.leads))} leads, ranked.`],
	['turn', 0.3, `Is each lead real? Cala says ${K.top} led ${words(K.claimed)} rounds next to ${K.with}.`],
	['turn', 0.3, 'Soft Yes opens the page Cala cites for each one.'],
	['turn', 0.35, own(f0) ? `${say(f0.company)}'s own page says ${f0.page[0]} led.` : `The page for ${say(f0.company)} says ${f0.page[0]} led.`],
	['turn', 0.8, `${say(f1.company)}'s round was led by ${f1.page[0]}.`],
	['turn', 0.35, `Only ${say(L.company)} holds, word for word.`],
	['turn', 0.35, `${cap(words(K.claimed))} became ${words(K.held)}. Write, you led ${say(f0.company)}, and the intro is gone.`],
	['lead', 0.3, `And Cala has ${first(L.name)} leading ${words(L.recent)} rounds in the last ${span(L.months)}.`],
	['ask', 0.3, `So ask ${Q.to} for the intro. Gemini writes the request.`],
	['ask', 0.35, 'Code checks every name and number in it against the facts.'],
	['audit', 0.3, `Don't take our word. Across every walk, ${words(U.confirmed)} lead claims hold word for word. ${cap(words(U.corrected))} were wrong.`],
	['audit', 0.35, "Type any company, and read who led it, in the page's own words."],
	['audit', 0.4, 'Soon, agents will act on graphs like this. A fact is safe to act on only when it comes with the sentence that proves it.'],
	['next', 0.3, 'Each top lead shows what it says on its own site, next to what it did.'],
	['next', 0.35, `${cap(words(N.slush.leads_attending))} of these leads are at Slush ${slushWhen()}. The request is ready to send.`],
	['close', 0.45, "Soft Yes. Turn we're in if you find a lead, into a lead."],
];
// ---- the cut made inside Claude (--cut3): numbers from src/data/cap3.json (film/capture/claude_shots.py)
const CUT3 = A.includes('--cut3');
const lines3 = () => {
	const C3 = JSON.parse(fs.readFileSync(path.join(film, 'src/data/cap3.json'), 'utf8'));
	const F = need(C3.cfind?.facts, 'cfind'), Li = need(C3.clist?.facts, 'clist'), Wk = need(C3.cwalk?.facts, 'cwalk'), D = need(C3.cdraft?.facts, 'cdraft');
	const facts = +need(/([\d,]+) facts/.exec(F.ledger[0])?.[1], 'the count of facts').replace(/,/g, '');
	if (!/^From a language model 0 facts/.test(F.ledger[3])) throw new Error('the card no longer shows 0 facts from a language model: rewrite the narration');
	const top = Li.leads[0];
	const when = new Date(C3.clist.at).toLocaleString('en-US', {month: 'short', year: 'numeric', timeZone: 'UTC'});
	const led = /^Led (.+?)’s (pre-seed|seed|Series \w) in (\w+ \d+)$/.exec(top.line);
	if (!led || !Li.proof?.includes('The page says it led')) throw new Error(`the first investor is no longer one the page says led a round ("${top.line}"): rewrite the narration`);
	const way = Li.way;
	const sat = /Sat in (\d+) rounds? with ([^,]+), an investor in/.exec(way.line);
	if (!sat) throw new Error(`the way in no longer reads "Sat in N rounds with X" ("${way.line}"): rewrite the narration`);
	const chk = /(\d+) “led” claims hold word for word, (\d+) do not/.exec(Wk.read);
	if (!chk) throw new Error(`the walk no longer says "N led claims hold, M do not" ("${Wk.read}"): rewrite the narration`);
	const lead = D.leads[0];
	const round = /^Led (\S+)/.exec(lead.line);
	const door = /^(.+?) opens the door: it was in that round/.exec(lead.door || '');
	if (!round || !door) throw new Error(`the first lead no longer has a door ("${lead.line}", "${lead.door}"): rewrite the narration`);
	const stage = led[2].startsWith('Series') ? led[2] : led[2];
	return [
		['ask', 0.2, `You're raising a ${stage} round. Who do you talk to? Ask Claude.`],
		['draw', 0.25, "Soft Yes asks Cala's graph for companies like yours."],
		['draw', 0.3, 'It reads their rounds, and who invested.'],
		['draw', 0.3, 'And the rounds investors you know sat in. Anyone in those is one intro away.'],
		['draw', 0.3, "Then it reads Cala's record of each investor. Does it lead rounds? Is it still investing?"],
		['draw', 0.35, `${cap(words(facts))} facts from Cala. None from a language model.`],
		['list', 0.3, `Start with ${top.name}. It led a ${stage} like yours ${led[3] === when ? 'this month' : 'in ' + led[3].split(' ')[0]}. Cala's source page says so.`],
		['list', 0.4, `${way.name} sat in ${words(+sat[1])} rounds with ${first(sat[2])}, an investor you know. That's your way in.`],
		['soft', 0.3, "Later, two investors say: we're in, if you find a lead."],
		['soft', 0.4, "That's a soft yes. So it finds who led the rounds they joined."],
		['soft', 0.3, `Then it reads Cala's source page for every lead. ${cap(words(+chk[1]))} check out. ${cap(words(+chk[2]))} don't.`],
		['draft', 0.3, `${lead.name} led ${say(round[1])}'s round with ${door[1]} in it. So ${door[1]} opens the door.`],
		['draft', 0.35, `One click writes the ask to ${door[1]}.`],
		['draft', 1.2, "Every fact in it is listed, with where it's from."],
		['close', 0.45, "Soft Yes. Find your investors in Cala's graph, in Claude."],
	];
};
if (CUT3) LINES.splice(0, LINES.length, ...lines3());
if (A.includes('--print')) {
	let last = '';
	for (const l of LINES) {
		console.log((l[0] === last ? '' : `\n[${l[0]}]\n`) + l[2]);
		last = l[0];
	}
	process.exit(0);
}

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error('ELEVENLABS_API_KEY missing (run through: hsec exec --only ELEVENLABS_API_KEY -- node scripts/make-vo.mjs)');
const voice = A.includes('--voice') ? A[A.indexOf('--voice') + 1] : 'nPczCjzI2devNBz1zQrb'; // "Brian" premade
const out = path.join(bulk, 'public/audio');
fs.mkdirSync(out, {recursive: true});
const sha = async (t) => Buffer.from(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(t))).toString('hex').slice(0, 10);
const lines = [];
for (let i = 0; i < LINES.length; i++) {
	const [scene, gap, text] = LINES[i];
	// one file per sentence text: a changed number re-makes only its own line
	const base = `vo-${await sha(voice + '|' + text)}`;
	const mp3 = path.join(out, `${base}.mp3`);
	const meta = path.join(out, `${base}.json`);
	let m = fs.existsSync(meta) && fs.existsSync(mp3) ? JSON.parse(fs.readFileSync(meta, 'utf8')) : null;
	if (!m) {
		const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
			method: 'POST',
			headers: {'xi-api-key': KEY, 'content-type': 'application/json'},
			body: JSON.stringify({text, model_id: 'eleven_multilingual_v2', voice_settings: {stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true, speed: 1.06}}),
		});
		if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 300)}`);
		const j = await r.json();
		fs.writeFileSync(mp3, Buffer.from(j.audio_base64, 'base64'));
		const al = j.alignment;
		// characters -> words with start/end seconds
		const ws = [];
		let cur = null;
		al.characters.forEach((ch, k) => {
			if (/\s/.test(ch)) {
				if (cur) ws.push(cur);
				cur = null;
				return;
			}
			if (!cur) cur = {w: '', s: al.character_start_times_seconds[k], e: 0};
			cur.w += ch;
			cur.e = al.character_end_times_seconds[k];
		});
		if (cur) ws.push(cur);
		m = {text, voice, dur: al.character_end_times_seconds.at(-1), words: ws};
		fs.writeFileSync(meta, JSON.stringify(m));
		console.log(`vo ${i} (${m.dur.toFixed(2)} s): ${text}`);
	}
	lines.push({scene, gap, text, file: `audio/${base}.mp3`, dur: m.dur, words: m.words});
}

// The music is made for the length of this cut: the same sum the film's timeline makes (src/data.ts).
const T = JSON.parse(fs.readFileSync(path.join(film, CUT3 ? 'src/data/timing3.json' : 'src/data/timing.json'), 'utf8'));
const starts = {};
let total = 0;
for (const id of T.order) {
	starts[id] = total;
	total += Math.ceil((lines.filter((l) => l.scene === id).reduce((a, l) => a + l.gap + l.dur, 0) + T.tail[id]) * 30) / 30;
}
const secs = Math.ceil(total);
let music = null;
const mf = path.join(out, `music-${CUT3 ? 'c3-' : ''}${secs}.mp3`);
const at = (id, plus = 0) => `${Math.round(starts[id] + plus)} s`;
if (A.includes('--music') && !fs.existsSync(mf)) {
	const r = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', {
		method: 'POST',
		headers: {'xi-api-key': KEY, 'content-type': 'application/json'},
		body: JSON.stringify({
			prompt: CUT3
				? `Modern, confident product film score, instrumental, 104 BPM, ${secs} seconds long. It starts at once, no slow intro: a warm analog synth arpeggio over a soft kick, with a clean lift at ${at('draw')}. ` +
					`Steady, optimistic drive with crisp light percussion and a rising bass line. At ${at('soft')} it thins to a sparse, curious pulse with single felt-piano notes for a few seconds, then builds again. ` +
					`A bigger lift at ${at('draft')}. At ${at('close')} it opens up into the final theme, then a calm, resolved ending with a soft final chord at ${secs - 2} s and silence after. ` +
					'No vocals. Understated, premium, Nordic, not cheesy.'
				: `Modern, confident product film score, instrumental, 104 BPM, ${secs} seconds long. It starts at once, no slow intro: a warm analog synth arpeggio over a soft kick, with a clean lift at 4 s. ` +
				`At ${at('turn')} it drops to something tense and sparse: a low sustained note, a ticking pulse, single felt-piano notes, building slowly. ` +
				`At ${at('lead', -3)} the tension resolves into a bright, warm lift with the full beat, crisp light percussion and a rising bass line. Steady, optimistic drive through the middle. ` +
				`A bigger lift at ${at('next')}. At ${at('close')} it opens up into the final theme, then a calm, resolved ending with a soft final chord at ${secs - 2} s and silence after. ` +
				'No vocals. Understated, premium, Nordic, not cheesy.',
			music_length_ms: secs * 1000,
			force_instrumental: true,
		}),
	});
	if (!r.ok) throw new Error(`music ${r.status}: ${(await r.text()).slice(0, 300)}`);
	fs.writeFileSync(mf, Buffer.from(await r.arrayBuffer()));
	console.log(`music written (${secs} s)`);
}
if (fs.existsSync(mf)) music = `audio/${path.basename(mf)}`;
else if (fs.existsSync(path.join(out, 'music.mp3'))) music = 'audio/music.mp3'; // the bed of the first cut: longer, and faded out at the end
fs.writeFileSync(path.join(film, CUT3 ? 'src/data/vo3.json' : 'src/data/vo.json'), JSON.stringify({voice, music, lines}, null, 1) + '\n');
console.log(`${CUT3 ? 'vo3' : 'vo'}.json: ${lines.length} lines, ${lines.reduce((a, l) => a + l.dur, 0).toFixed(1)} s of voice, film ${total.toFixed(1)} s, music ${music}`);
