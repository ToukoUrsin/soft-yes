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
	// 1,172 is said "eleven hundred and seventy-two"; a round thousand, and anything from 2,000 up, by its thousands
	if (n < 2000 && n % 1000 >= 100) return words(Math.floor(n / 100)) + ' hundred' + (n % 100 ? ' and ' + words(n % 100) : '');
	if (n < 1e6) return words(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? (n % 1000 < 100 ? ' and ' : ' ') + words(n % 1000) : '');
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
	const F = need(C3.cfind?.facts, 'cfind'), I = need(C3.cinv?.facts, 'cinv'), S = need(C3.csoft?.facts, 'csoft');
	// every number the voice says is on the card in the recording: a card that changed stops the film here
	const bad = (what) => {
		throw new Error(`${what}: rewrite the narration (the Soft Yes tab of ~/junction/.booth/lines.json carries the same lines)`);
	};
	if (!/^From a language model 0 facts/.test(F.ledger[3])) bad('the card no longer shows 0 facts from a language model');
	if (!/\b65 investors around 11 companies like yours/.test(F.head)) bad(`the search no longer finds 65 investors around 11 companies ("${F.head}")`);
	const top = I.leads[0];
	if (top.name !== 'Ovni Capital') bad(`the first investor is ${top.name}, not Ovni Capital`);
	if (I.chips.length !== 8 || I.chips_on !== 7) bad(`Ovni no longer has seven of eight signals (${I.chips_on} of ${I.chips.length})`);
	const why = I.why.join(' | ');
	if (!/Bleu Robotics pre-seed, Nov 2026 \(led\)/.test(why)) bad('the signal "Recent in your field" no longer names the Bleu Robotics pre-seed of Nov 2026 as led');
	if (!/3 Pre-seed rounds in Cala, led 2/.test(why)) bad('Ovni no longer led two of its three pre-seed rounds');
	if (!/\$57\.12M fund .*closed Jun 2025/.test(why)) bad('the new fund is no longer $57.12M, closed Jun 2025');
	if (I.latest.length !== 5 || I.latest_in.length !== 2) bad(`the latest rounds are no longer five with two in the field (${I.latest.length}, ${I.latest_in.length})`);
	if (!/Daphni \(2 rounds\)/.test(I.cos || '') || !/Kima \(2 rounds\)/.test(I.cos || '')) bad(`"Invests with" no longer reads Daphni (2 rounds), Kima (2 rounds) ("${I.cos}")`);
	const ch = need(I.chain, 'the way in under the first investor');
	if (ch.names.join(' > ') !== 'Cala AI > Kfund > FJ Labs > Contrarian Ventures > Ovni Capital') bad(`the way in is no longer Cala AI > Kfund > FJ Labs > Contrarian > Ovni (${ch.names.join(' > ')})`);
	if (ch.pages.length !== 3 || !ch.pages.every((x) => x.ok)) bad(`a link of the way in is not confirmed by its page (${ch.pages.map((x) => x.text).join(' | ')})`);
	if (!/1 round together/.test(ch.links[1]) || !/2 rounds together/.test(ch.links[2]) || !/Bleu Robotics/.test(ch.links[3])) bad(`the links of the way in changed (${ch.links.join(' | ')})`);
	if (!S.leads?.length) bad('the soft yes card shows no leads');
	// The investor search comes first: the signals, the latest rounds, the way in link by link. The soft yes is one short beat.
	// These are the lines Touko reads (the Soft Yes tab of ~/junction/.booth/lines-mac.html carries the same text): change one and the other has to follow.
	return [
		['open', 0.35, "I'm about to raise a round. Who do I raise from? And who gets me in the door?"],
		['ask', 0.3, 'So I asked Claude: who should fund my AI lab?'],
		['find', 0.3, 'Soft Yes pulls companies like mine from Cala, then the 65 investors in their rounds. None of it comes from the AI.'],
		['inv', 0.3, 'How do I pick? Eight signals for each investor, all read from Cala. Is it investing now? Is it near me?'],
		['inv', 0.45, 'Ovni Capital comes first, with seven of the eight. Has it backed my field lately? This November it co-led the pre-seed of Bleu Robotics, which makes AI training software for robots. It led two of its three pre-seeds, and closed a 57 million dollar fund last year.'],
		['inv', 0.5, "Here are its last five rounds. Two are in my field. It has invested twice with Daphni and twice with Kima, so I'd pitch those two next."],
		['inv', 0.55, "I've never met Ovni. But I know the Cala team. Their investor Kfund did a round with FJ Labs. FJ Labs did two with Contrarian. Contrarian co-led Bleu Robotics with Ovni. That's three intros from Kfund, and every link opens the page that names both funds."],
		['soft', 0.4, "Two investors told me yes, if I find a lead. That's a soft yes. I name them, and it shows who led the rounds they joined."],
		['close', 0.5, "It's called Soft Yes. Add it to Claude or ChatGPT and ask."],
	];
};
if (CUT3) LINES.splice(0, LINES.length, ...lines3());
if (A.includes('--json')) {
	console.log(JSON.stringify(LINES.map(([scene, gap, text]) => ({scene, gap, text}))));
	process.exit(0);
}
if (A.includes('--print')) {
	let last = '';
	for (const l of LINES) {
		console.log((l[0] === last ? '' : `\n[${l[0]}]\n`) + l[2]);
		last = l[0];
	}
	process.exit(0);
}

// --recorded FILE.json: a recorded voice, already cut line by line (scripts/voice-in.py), in place of the generated one
const REC = A.includes('--recorded') ? JSON.parse(fs.readFileSync(A[A.indexOf('--recorded') + 1], 'utf8')) : null;
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY && (!REC || A.includes('--music'))) throw new Error('ELEVENLABS_API_KEY missing (run through: hsec exec --only ELEVENLABS_API_KEY -- node scripts/make-vo.mjs)');
const voice = REC ? 'recorded' : A.includes('--voice') ? A[A.indexOf('--voice') + 1] : 'nPczCjzI2devNBz1zQrb'; // "Brian" premade
const out = path.join(bulk, 'public/audio');
fs.mkdirSync(out, {recursive: true});
const sha = async (t) => Buffer.from(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(t))).toString('hex').slice(0, 10);
const lines = [];
for (let i = 0; i < LINES.length; i++) {
	const [scene, gap, text] = LINES[i];
	if (REC) {
		const r = REC[i];
		if (!r || r.text !== text) throw new Error(`the recorded voice has no line ${i} with this text: "${text}"`);
		lines.push({scene, gap, text, file: r.file, dur: r.dur, words: r.words});
		continue;
	}
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

// The cold open is 10 s of picture with the first line over it. Its type is set to the picture: the first question has
// to be up before the open cuts to the fallen tile at 6.1 s, and the second ("And who gets me in the door?") belongs on
// that tile. So the line starts as late as that allows. Worked out from the words, so it holds for any voice.
if (CUT3) {
	const first = lines.find((x) => x.scene === 'open');
	const and = first.words.find((x) => /^and$/i.test(x.w));
	if (!and) throw new Error(`the open's line no longer has "And who gets me in the door?" ("${first.text}")`);
	first.gap = +Math.max(0.3, Math.min(6.25 - and.s, 9.5 - first.dur)).toFixed(3);
	const room = 9.8 - (first.gap + first.dur);
	if (room < 0) console.warn(`the first line is ${first.dur.toFixed(1)} s: it runs out of the cold open by ${(-room).toFixed(2)} s. Read it faster or cut the open's line.`);
	// the team's clip is between the open and Claude: "So I asked Claude" answers their last words
	lines.find((x) => x.scene === 'ask').gap = 0.2;
}

// The team's own clips (scripts/team-in.py) are lines of the film like the narration: captioned, and the music ducks under them.
if (CUT3 && fs.existsSync(path.join(film, 'src/data/team3.json'))) {
	const team = JSON.parse(fs.readFileSync(path.join(film, 'src/data/team3.json'), 'utf8'));
	const row = (c) => ({scene: c.scene, gap: 0, text: c.text, file: c.file, dur: c.dur, words: c.words, live: true});
	if (team.open) lines.unshift(row(team.open));
	if (team.thanks) lines.push(row(team.thanks));
}

// The music is made for the length of this cut: the same sum the film's timeline makes (src/data.ts).
const T = JSON.parse(fs.readFileSync(path.join(film, CUT3 ? 'src/data/timing3.json' : 'src/data/timing.json'), 'utf8'));
const starts = {};
let total = 0;
for (const id of T.order) {
	starts[id] = total;
	total += T.fixed?.[id] ?? Math.ceil((lines.filter((l) => l.scene === id).reduce((a, l) => a + l.gap + l.dur, 0) + T.tail[id]) * 30) / 30;
}
const m0 = T.musicFrom ? starts[T.musicFrom] : 0; // the music starts with that scene (the team talks without it)
const secs = Math.ceil(total - m0);
let music = null;
const mf = path.join(out, `music-${CUT3 ? 'c4-' : ''}${secs}.mp3`);
const at = (id, plus = 0) => `${Math.round(starts[id] - m0 + plus)} s`; // in the music's own seconds
if (A.includes('--music') && !fs.existsSync(mf)) {
	const r = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', {
		method: 'POST',
		headers: {'xi-api-key': KEY, 'content-type': 'application/json'},
		body: JSON.stringify({
			prompt: CUT3
				? `Modern, understated product film score, instrumental, 100 BPM, ${secs} seconds long. The first ${at(T.order[1])} are dark and sparse: a low sustained note and single felt-piano notes, a slow build, no drums. ` +
					(T.order[1] === 'team' ? `From ${at('team')} to ${at('ask')} people talk to the camera: it holds back even more, only the low note and a soft slow pulse. ` : '') +
					`At ${at('ask')} a warm analog synth arpeggio comes in over a soft kick. A lift at ${at('find')}. Steady, calm drive with crisp light percussion through the long middle. ` +
					`At ${at('soft')} it thins to a sparse, curious pulse for a few seconds. At ${at('close')} it opens up into the final theme, then a calm, resolved ending with a soft final chord at ${secs - 2} s and silence after. ` +
					'It sits under a speaking voice the whole time: no lead melody, nothing busy. No vocals. Premium, Nordic, not cheesy.'
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
else if (CUT3) {
	// no bed of this exact length yet (--music makes one): the shortest longer one, which the film fades out at its end
	const longer = fs.readdirSync(out).map((f) => /^music-c4-(\d+)\.mp3$/.exec(f)).filter((m) => m && +m[1] >= secs).sort((a, b) => +a[1] - +b[1])[0];
	if (longer) music = `audio/${longer[0]}`;
}
if (!music && fs.existsSync(path.join(out, 'music.mp3'))) music = 'audio/music.mp3'; // the bed of the first cut: longer, and faded out at the end
fs.writeFileSync(path.join(film, CUT3 ? 'src/data/vo3.json' : 'src/data/vo.json'), JSON.stringify({voice, music, lines}, null, 1) + '\n');
console.log(`${CUT3 ? 'vo3' : 'vo'}.json: ${lines.length} lines, ${lines.reduce((a, l) => a + l.dur, 0).toFixed(1)} s of voice, film ${total.toFixed(1)} s, music ${music}`);
