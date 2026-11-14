import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {type Box, box, cap, cues, said} from './data';
import timing from './data/timing.json';
import {C, FPS, MONO, SANS, clamp, ease, pop, soft} from './theme';
import {type Cam, type Hi, type Seg, Head, Mark, SceneFade, Shot, Stage, WIN, fit} from './ui';

const useT = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();
	return {frame, t: frame / FPS, end: durationInFrames / FPS};
};
const F = (s: number) => Math.round(s * FPS);
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const num = (n: number) => n.toLocaleString('en-US');

// numbers the film says and shows, all read from the product at capture time (src/data/cap.json)
const W = cap.walk.facts;
const K = cap.check.facts;
const L = cap.lead.facts;
const Q = cap.ask.facts;
const U = cap.audit.facts;
const N = cap.next.facts;
const FINDS = K.finds as {company: string; cala: string; page: string[]; publisher: string; url: string}[];
const firstWord = (s: string) => s.split(' ')[0];
const short = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

// ------------------------------------------------------------------------------------------------ 1. the hook, the walk, the list
// The second, inside this scene, at which the walk has folded into the ranked list: the frame saved as out/screenshot.png.
export const revealAt = () => cues('open')[cues('open').length - 1].s + timing.reveal;
export const SceneOpen: React.FC = () => {
	const {end} = useT();
	const [c0, c1, c2, c3] = cues('open');
	const M = cap.walk.marks;
	const tPick = 1.5; // the second investor is in
	const tGo = 2.5; // "Find the lead" is clicked here
	const tFold = c3.s - 0.3; // the walk is done and folds into the ranked list
	const but = said('open', 0, 'but');
	const segs: Seg[] = [
		[0, tPick, M.type1 - 0.15, M.picked1 + 0.15], // the first name is in, the second is typed
		[tPick, tGo, M.go - (tGo - tPick) + 0.05], // a cut: the stage is chosen, the button is clicked
		[tGo, tFold, M.go + 0.05, M.done - 0.15],
		[tFold, end, M.done - 0.15],
	];
	const graph: [number, number, number] = [-60, 150, 2040];
	const cams: Cam[] = [
		{t: 0, r: [0, 76, 1400]},
		{t: tGo + 0.55, d: 0.5, r: graph},
		{t: but + 0.5, d: 0.8, r: fit(box('walk', 'node'), 940, {ax: 0.2, top: 250})},
		{t: c1.s + 1.0, d: 0.9, r: graph},
		{t: tFold + 1.0, d: 0.8, r: [0, 76, 1920]},
	];
	const his: Hi[] = [
		{box: box('walk', 'field'), from: 0.1, to: tPick, pad: 0},
		{box: box('walk', 'node'), from: but + 0.3, to: c1.s + 0.3, pad: 6},
		{box: box('walk', 'headline'), from: tFold + 0.9, to: end + 1, pad: 4},
		{box: box('walk', 'tally'), from: tFold + 1.2, to: end + 1, pad: 2},
	];
	const ty = W.tally;
	const n = W.node;
	return (
		<SceneFade inF={0}>
			<Head
				tag="SOFT YES"
				items={[
					{t: 0, text: '“We’re in, if you find a lead.”'},
					{t: but - 0.1, text: n.rounds === n.rounds_done ? `In Cala, ${n.name} led ${n.led} of its ${plural(n.rounds, 'round')}` : `In Cala, ${n.name} led ${plural(n.led, 'round')}`},
					{t: c1.s, text: 'So who led the others?'},
					{t: c2.s, text: 'Soft Yes finds who led the rounds your investors joined'},
					{t: c3.s - 0.1, text: `${W.leads} leads, ranked · ${ty['Cala calls']} Cala calls · ${ty.facts} facts · ${ty['from a language model']} from a language model`},
				]}
			/>
			<Stage>
				<Shot clip="walk" segs={segs} cams={cams} his={his} />
			</Stage>
		</SceneFade>
	);
};

// ------------------------------------------------------------------------------------------------ 2. the page check: three claims become one
// The count in the corner of the stage: how many of the lead's rounds still stand.
const Score: React.FC<{label: string[]; steps: {t: number; n: number; ok?: boolean; note: string}[]; to: number}> = ({label, steps, to}) => {
	const {frame, t} = useT();
	if (t < steps[0].t || t > to) return null;
	let i = 0;
	steps.forEach((s, k) => {
		if (t >= s.t) i = k;
	});
	const cur = steps[i];
	const a = Math.min(soft(frame, F(steps[0].t)), interpolate(t, [to - 0.2, to], [1, 0], clamp));
	const p = pop(frame, F(cur.t), 12, 0.5);
	const col = cur.ok ? C.accent : i > 0 ? C.amber : C.text;
	return (
		<div style={{position: 'absolute', right: 22, top: 20, width: 330, padding: '16px 22px 16px', borderRadius: 18, background: 'rgba(10,10,10,0.94)', border: `2px solid ${col}99`, boxShadow: `0 18px 60px rgba(0,0,0,0.7), 0 0 50px ${col}22`, opacity: a, transform: `translateY(${(1 - a) * -14}px)`, fontFamily: SANS}}>
			<div style={{fontFamily: MONO, fontSize: 17, fontWeight: 700, letterSpacing: 1.2, color: C.dim, lineHeight: 1.35}}>
				{label.map((l) => (
					<div key={l}>{l}</div>
				))}
			</div>
			<div style={{display: 'flex', alignItems: 'baseline', gap: 16, marginTop: 2}}>
				<div style={{fontSize: 150, fontWeight: 700, letterSpacing: -6, lineHeight: 1, color: col, transform: `scale(${0.7 + 0.3 * p})`, transformOrigin: '20% 80%', fontVariantNumeric: 'tabular-nums'}}>{cur.n}</div>
				<div style={{fontSize: 27, fontWeight: 600, color: col, letterSpacing: -0.4, lineHeight: 1.15}}>{cur.note}</div>
			</div>
		</div>
	);
};
export const SceneTurn: React.FC = () => {
	const {frame, t, end} = useT();
	const [c0, c1, c2, c3, c4, c5] = cues('turn');
	const M = cap.check.marks;
	const ML = cap.lead.marks;
	const [f0, f1] = FINDS;
	const tOpen = c2.s - 0.5; // the page check line is clicked open
	const tPage = said('turn', 2, 'says') - 0.1; // cut to the page Cala cites
	const tBack = c3.s - 0.2;
	const tHolds = c4.s - 0.2; // cut to the round that holds
	const tSum = c5.s - 0.15;
	const lead0 = said('turn', 2, firstWord(f0.page[0]));
	const lead1 = said('turn', 3, firstWord(f1.page[0]));
	const write = said('turn', 5, 'write');
	const gone = said('turn', 5, 'gone');
	const a: Seg[] = [
		[0, tOpen, Math.max(0, M.open - 0.1 - tOpen), M.open - 0.1], // the page stands still until the line is clicked open
		[tOpen, tPage, M.open - 0.1],
	];
	// one finding fills the window: the claim struck through, the page's sentence under it
	const findCam = (b: Box): [number, number, number] => [b[0] - 21, b[1] - 34, b[2] + 72];
	const strip = box('check', 'strip');
	const camsA: Cam[] = [
		{t: 0, r: [0, 0, 1920]},
		{t: c0.s + 2.0, d: 1.3, r: fit(box('check', 'toprow'), 1320, {ax: 0.7, top: 290})},
		{t: c1.s + 0.7, d: 0.8, r: [10, strip[1] - 160, 1900]},
		{t: tOpen + 0.75, d: 0.6, r: findCam(box('check', 'find0'))},
	];
	const hisA: Hi[] = [
		{box: box('check', 'toprow'), from: c0.s + 1.9, to: c1.s + 0.2, pad: 3},
		{box: box('check', 'counts'), from: c1.s + 0.6, to: tOpen + 0.2, pad: 2},
		{box: box('check', 'cala0'), from: tOpen + 0.7, to: end, pad: 4, color: C.amber},
	];
	const three = said('turn', 0, firstWord(String(c0.line.text.match(/led (\w+) rounds/)?.[1] ?? 'led')));
	const a5 = interpolate(t, [tSum, tSum + 0.3], [0, 1], clamp);
	const strike = interpolate(t, [gone - 0.15, gone + 0.25], [0, 1], {...clamp, easing: ease.out});
	const from3 = interpolate(t, [tSum + 0.15, tSum + 0.55], [0, 1], {...clamp, easing: ease.out});
	const quote = soft(frame, F(write - 0.1));
	return (
		<SceneFade>
			<Head
				tag="PAGE CHECK"
				items={[
					{t: 0, text: 'Is each lead real?'},
					{t: three - 0.9, text: `Cala: ${K.top} led ${plural(K.claimed, 'round')} next to ${K.with}`},
					{t: c1.s, text: 'Soft Yes opens the page Cala cites for each one'},
					{t: c2.s, text: `${f0.company}: the page says ${f0.page[0]} led`},
					{t: c3.s, text: `${f1.company}: the page says ${f1.page[0]} led`},
					{t: c4.s, text: `${L.company}: confirmed on the page, word for word`},
					{t: c5.s, text: `${K.claimed} lead claims became ${K.held}`},
				]}
			/>
			<Stage>
				<Shot clip="check" to={tPage} segs={a} cams={camsA} his={hisA} />
				<Shot
					clip="page"
					from={tPage}
					to={tBack}
					segs={[[tPage, tBack, 0.5]]}
					cams={[
						{t: 0, r: [24, -70, 1190]},
						{t: tBack, d: tBack - tPage, r: [30, -60, 1170]},
					]}
					his={Array.from({length: cap.page.facts.lines as number}, (_, i) => ({box: box('page', `line${i}`), from: tPage + 0.3 + i * 0.3, to: end, pad: 2, fill: 'light' as const}))}
					bg="#fff"
					label={short(cap.page.facts.url)}
				/>
				<Shot
					clip="check"
					from={tBack}
					to={tHolds}
					segs={[[tBack, tHolds, M.find1 + 0.2]]}
					cams={[{t: 0, r: findCam(box('check', 'find1'))}]}
					his={[
						{box: box('check', 'cala1'), from: c3.s, to: end, pad: 4, color: C.amber},
						{box: box('check', 'quote1'), from: lead1 - 0.3, to: end, pad: 2, color: C.amber},
					]}
				/>
				<Shot
					clip="lead"
					from={tHolds}
					to={tSum}
					segs={[[tHolds, tSum, ML.quote + 0.4]]}
					cams={[
						{t: 0, r: [650, box('lead', 'round')[1] - 8, 1222]},
						{t: tSum, d: tSum - tHolds, r: [656, box('lead', 'round')[1] - 6, 1210]},
					]}
					his={[{box: box('lead', 'quote'), from: c4.s + 0.1, to: end, pad: 2}]}
				/>
				<Shot clip="check" from={tSum} segs={[[tSum, end, M.both + 0.4]]} cams={[{t: 0, r: fit(box('check', 'both'), 1900, {top: 60})}]} />
				<Score
					label={[`ROUNDS ${firstWord(K.top).toUpperCase()} LED`, `NEXT TO ${String(K.with).toUpperCase()}`]}
					to={tSum}
					steps={[
						{t: three - 0.1, n: K.claimed, note: 'Cala says'},
						{t: lead0, n: K.claimed - 1, note: 'still stand'},
						{t: lead1, n: K.claimed - 2, note: 'still stands'},
						{t: said('turn', 4, 'holds'), n: K.held, ok: true, note: 'holds, word for word'},
					]}
				/>
				{a5 > 0 ? (
					<AbsoluteFill style={{background: `rgba(10,10,10,${0.9 * a5})`, alignItems: 'center', justifyContent: 'center', fontFamily: SANS}}>
						<div style={{display: 'flex', alignItems: 'center', gap: 44, opacity: a5}}>
							<div style={{position: 'relative', fontSize: 250, fontWeight: 700, letterSpacing: -10, lineHeight: 1, color: C.dim}}>
								{K.claimed}
								<span style={{position: 'absolute', left: -14, top: '52%', height: 12, borderRadius: 6, width: `${from3 * 122}%`, background: C.amber}} />
							</div>
							<div style={{fontSize: 130, fontWeight: 500, color: C.dim, opacity: from3}}>→</div>
							<div style={{fontSize: 250, fontWeight: 700, letterSpacing: -10, lineHeight: 1, color: C.accent, opacity: from3, transform: `scale(${0.8 + 0.2 * from3})`}}>{K.held}</div>
						</div>
						<div style={{marginTop: 34, position: 'relative', fontSize: 78, fontWeight: 700, letterSpacing: -2.6, color: strike > 0.5 ? C.dim : C.text, opacity: quote, transform: `translateY(${(1 - quote) * 16}px)`}}>
							“You led {f0.company}’s round.”
							<span style={{position: 'absolute', left: -10, top: '54%', height: 9, borderRadius: 5, width: `${strike * 102}%`, background: C.amber}} />
						</div>
					</AbsoluteFill>
				) : null}
			</Stage>
		</SceneFade>
	);
};

// ------------------------------------------------------------------------------------------------ 3. the lead that holds still leads
export const SceneLead: React.FC = () => {
	const {end} = useT();
	const M = cap.lead.marks;
	const still = box('lead', 'still');
	return (
		<SceneFade>
			<Head tag="THE LEAD" items={[{t: 0, text: `${L.name} still leads: ${plural(L.recent, 'round')} in the last ${L.months} months`}]} />
			<Stage>
				<Shot
					clip="lead"
					segs={[[0, end, M.bars - 0.7]]}
					cams={[
						{t: 0, r: [650, still[1] - 40, 1222]},
						{t: end, d: end - 0.2, r: [652, still[1] - 36, 1213]},
					]}
					his={[{box: still, from: 0.7, to: end + 1, pad: 2}]}
				/>
			</Stage>
		</SceneFade>
	);
};

// ------------------------------------------------------------------------------------------------ 4. the ask, and the model being checked
export const SceneAsk: React.FC = () => {
	const {end} = useT();
	const [c0, c1] = cues('ask');
	const M = cap.ask.marks;
	const tDraft = said('ask', 0, 'gemini') - 0.25;
	const tFacts = said('ask', 1, 'against') - 0.2;
	const draft = box('ask', 'draft');
	const facts = box('ask', 'facts');
	const wide = (b: Box): [number, number, number] => [b[0] - 32, b[1] - 60, b[2] + 64];
	return (
		<SceneFade>
			<Head
				tag="THE ASK"
				items={[
					{t: 0, text: `Ask ${Q.to} for the intro to ${Q.lead}`},
					{t: tDraft, text: 'Gemini writes the request'},
					{t: c1.s, text: Q.dropped ? 'Its first draft added something. It was dropped.' : 'Code checks every name and number in it'},
					{t: tFacts, text: `Against ${plural(Q.facts, 'fact')} from Cala and the founder’s own words`},
				]}
			/>
			<Stage>
				{/* the founder's last line is typed, then the cut skips the seconds Gemini takes */}
				<Shot clip="ask" to={tDraft} segs={[[0, tDraft, M.filled - tDraft + 0.15]]} cams={[{t: 0, r: [box('ask', 'ask')[0] - 32, box('ask', 'ask')[1] - 250, box('ask', 'ask')[2] + 64]}]} />
				<Shot
					clip="ask"
					from={tDraft}
					to={tFacts}
					segs={[[tDraft, tFacts, M.checked - (c1.s - tDraft) - 0.2]]}
					cams={[
						{t: 0, r: wide(draft)},
						{t: tFacts, d: tFacts - tDraft - 0.1, r: [draft[0] - 24, draft[1] - 44, draft[2] + 48]},
					]}
					his={[{box: box('ask', 'checked'), from: c1.s + 0.1, to: end, pad: 2}]}
				/>
				<Shot clip="ask" from={tFacts} segs={[[tFacts, end, M.facts - 0.3]]} cams={[{t: 0, r: [facts[0] - 19, facts[1] - 15, 1020]}]} />
			</Stage>
		</SceneFade>
	);
};

// ------------------------------------------------------------------------------------------------ 5. check us
export const SceneAudit: React.FC = () => {
	const {end} = useT();
	const [c0, c1, c2] = cues('audit');
	const M = cap.audit.marks;
	const tType = c1.s - 0.25;
	const tTyped = tType + 0.25 + (M.asked - M.type); // the name is in, typed at real speed
	const tAnswer = Math.max(tTyped + 0.5, said('audit', 1, 'read') + 0.35); // cut to the answer: the seconds the pages take to load are not shown
	const tSafe = said('audit', 2, 'a', 0) - 0.2; // "A fact is safe to act on ..."
	const hold = said('audit', 0, 'hold') - 0.6;
	const wrong = said('audit', 0, 'wrong') - 0.7;
	const segs: Seg[] = [
		[0, tType, M.totals - 1.0, M.totals + 4.2], // the page stands still here
		[tType, tTyped, M.type - 0.25, M.asked],
		[tTyped, tAnswer, M.asked],
		[tAnswer, end, M.answer0 - 0.15, M.answer0 + 4.0],
	];
	const legend = box('audit', 'n_confirmed');
	const answer: [number, number, number] = [40, box('audit', 'summary')[1] - 150, 1345]; // the company, its summary, the first round with its sentence
	const cams: Cam[] = [
		{t: 0, r: [0, 0, 1920]},
		{t: c0.s + 1.5, d: 1.0, r: [28, 104, 1190]},
		{t: hold + 0.2, d: 0.9, r: [30, legend[1] - 100, 1176]},
		{t: tType, d: 0.02, r: [0, 0, 1920]},
		{t: tAnswer - 0.05, d: tAnswer - tType - 0.1, r: [10, 6, 1900]},
		{t: tAnswer, d: 0.02, r: answer},
		{t: end, d: end - tAnswer - 0.1, r: [answer[0] + 6, answer[1] + 4, answer[2] - 22]},
	];
	const his: Hi[] = [
		{box: box('audit', 'n_confirmed'), from: hold, to: tType, pad: 2},
		{box: box('audit', 'n_corrected'), from: wrong, to: tType, pad: 2, color: C.amber},
		{box: box('audit', 'form'), from: tType + 0.1, to: tAnswer, pad: 0},
		{box: box('audit', 'claim0'), from: tAnswer + 0.5, to: end + 1, pad: 2, color: C.amber},
		{box: box('audit', 'proof0'), from: Math.max(tAnswer + 1.0, said('audit', 1, 'page') - 0.2), to: end + 1, pad: 4},
	];
	return (
		<SceneFade>
			<Head
				tag="CHECK US"
				items={[
					{t: 0, text: `Every walk so far: ${num(U.pages)} pages read`},
					{t: hold - 0.6, text: `${num(U.confirmed)} lead claims confirmed word for word · ${num(U.corrected)} corrected`},
					{t: c1.s, text: `Type any company. Here: ${U.company}`},
					{t: tAnswer, text: `${U.claim}: here is the page’s sentence`},
					{t: c2.s, text: 'Soon, agents will act on graphs like this'},
					{t: tSafe, text: 'A fact is safe to act on with the sentence that proves it'},
				]}
			/>
			<Stage>
				<Shot clip="audit" segs={segs} cams={cams} his={his} />
			</Stage>
		</SceneFade>
	);
};

// ------------------------------------------------------------------------------------------------ 6. what is left to do
export const SceneNext: React.FC = () => {
	const {end} = useT();
	const [c0, c1] = cues('next');
	const M = cap.next.marks;
	const MA = cap.ask.marks;
	const tSlush = c1.s - 0.2;
	const tReady = said('next', 1, 'request') - 0.45; // "The request is ready to send."
	const says = box('next', 'says');
	const row = box('next', 'row');
	const did: Box | null = (cap.next.boxes.did as Box) ?? null;
	const draft = box('ask', 'draft2');
	// the lead's row in the list with its two lines, and nothing of the column next to it
	const bottom = (did ?? says)[1] + (did ?? says)[3];
	const listW = Math.max(row[2] + 8, ((bottom - row[1] + 28) * WIN.w) / WIN.h);
	return (
		<SceneFade>
			<Head
				tag="BEFORE YOU WRITE"
				items={[
					{t: 0, text: `${N.name}: its own site, next to what it did`},
					{t: c1.s, text: `${plural(N.slush.leads_attending, 'lead')} registered for Slush, ${N.slush.days_away === 0 ? 'which starts today' : `${plural(N.slush.days_away, 'day')} away`}`},
					{t: tReady, text: `The request to ${Q.to} is ready to send`},
				]}
			/>
			<Stage>
				<Shot
					clip="next"
					to={tReady}
					segs={[
						[0, tSlush, M.says - 0.6, M.says + 3.8],
						[tSlush, tReady, M.slush - 0.5],
					]}
					cams={[
						{t: 0, r: [row[0] - (listW - row[2]) / 2, row[1] - 12, listW]},
						{t: tSlush, d: 0.02, r: [0, 30, 1920]},
						{t: tReady, d: tReady - tSlush - 0.1, r: [20, 40, 1880]},
					]}
					his={[
						{box: says, from: 0.5, to: tSlush, pad: 2},
						...(did ? [{box: did, from: said('next', 0, 'next') - 0.2, to: tSlush, pad: 2, color: C.amber}] : []),
						{box: box('next', 'slushn0'), from: c1.s + 0.15, to: end, pad: 3},
						{box: box('next', 'tag0'), from: c1.s + 0.7, to: end, pad: 2},
					]}
				/>
				<Shot
					clip="ask"
					from={tReady}
					segs={[[tReady, end, MA.copy - 1.0]]}
					cams={[
						{t: 0, r: [draft[0] - 32, draft[1] - 60, draft[2] + 64]},
						{t: end, d: end - tReady, r: [draft[0] - 26, draft[1] - 56, draft[2] + 44]},
					]}
					his={[{box: box('ask', 'copy'), from: tReady + 0.5, to: end + 1, pad: 3}]}
				/>
			</Stage>
		</SceneFade>
	);
};

// ------------------------------------------------------------------------------------------------ 7. close
export const SceneClose: React.FC = () => {
	const {frame, t} = useT();
	const turn = said('close', 0, 'turn');
	const b1 = pop(frame, 2, 16, 0.7);
	const b2 = soft(frame, F(turn - 0.15));
	const b3 = soft(frame, F(said('close', 0, 'into') + 0.45));
	const draw = interpolate(t, [0.05, 0.8], [0, 1], {...clamp, easing: ease.out});
	return (
		<SceneFade inF={6} outF={0}>
			<AbsoluteFill style={{fontFamily: SANS, alignItems: 'center', justifyContent: 'center', paddingBottom: 30}}>
				<div style={{display: 'flex', alignItems: 'center', gap: 34, transform: `scale(${0.95 + 0.05 * b1})`, opacity: Math.min(1, b1 * 1.5)}}>
					<Mark size={104} draw={draw} />
					<div style={{fontSize: 132, fontWeight: 700, letterSpacing: -5.5, color: C.text, lineHeight: 1}}>Soft Yes</div>
				</div>
				<div style={{marginTop: 46, fontSize: 70, fontWeight: 600, letterSpacing: -2.2, color: C.text, opacity: b2, transform: `translateY(${(1 - b2) * 16}px)`}}>
					Turn <span style={{color: C.dim}}>“we’re in if you find a lead”</span> into <span style={{color: C.accent}}>a lead.</span>
				</div>
				<div style={{marginTop: 56, fontFamily: MONO, fontSize: 44, fontWeight: 500, color: C.text, padding: '14px 36px', borderRadius: 14, border: `1px solid ${C.line2}`, background: 'rgba(255,255,255,0.05)', opacity: b3, transform: `translateY(${(1 - b3) * 12}px)`}}>soft-yes.fly.dev</div>
				<div style={{marginTop: 40, fontSize: 27, fontWeight: 500, color: C.dimmer, letterSpacing: -0.2, opacity: b3}}>Built with Cala, Gemini, Oxylabs and the Slush MCP</div>
			</AbsoluteFill>
		</SceneFade>
	);
};
export const STAGE = WIN;
