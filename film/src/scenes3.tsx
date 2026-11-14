import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {type Scene3, box, cap, cut3} from './data';
import {C, FPS, MONO, SANS, clamp, ease, pop, soft} from './theme';
import {type Cam, type Hi, type Seg, Head, Mark, SceneFade, Shot, Stage, WIN} from './ui';

// The cut made inside Claude: Soft Yes as a connector, its cards drawn in the chat.
// Every clip is a recording of claude.ai (film/capture/claude_shots.py); every number is read from the card.
const {cues, said} = cut3;
const useT = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();
	return {frame, t: frame / FPS, end: durationInFrames / FPS};
};
const F = (s: number) => Math.round(s * FPS);
type Rect = [number, number, number];
const GREEN = '#15803D'; // outlines that read on Claude's white page
const AMBER = '#B45309';
const WHITE = '#FFFFFF';
const num = (s: string, re: RegExp) => (re.exec(s || '') || [])[1] || '';
// Scene seconds a..b show clip seconds from..to: at its real speed and then held when there is time to spare, sped up when there is not.
const play = (a: number, b: number, from: number, to: number): Seg[] => {
	const len = to - from;
	return len >= b - a - 0.05 ? [[a, b, from, to]] : [[a, a + len, from, to], [a + len, b, to, to]];
};

const FIND = cap.cfind.facts;
const LIST = cap.clist.facts;
const WALK = cap.cwalk.facts;
const DRAFT = cap.cdraft.facts;

// A small note above the stage, on the right: what was cut out, said plainly.
const Chip: React.FC<{from: number; to: number; text: string}> = ({from, to, text}) => {
	const {t} = useT();
	const o = Math.min(interpolate(t, [from, from + 0.2], [0, 1], clamp), interpolate(t, [to - 0.25, to], [1, 0], clamp));
	if (o <= 0) return null;
	return (
		<div style={{position: 'absolute', right: 1920 - WIN.x - WIN.w, top: WIN.y - 46, opacity: o, fontFamily: MONO, fontSize: 19, fontWeight: 700, color: C.accent, background: 'rgba(10,10,10,0.86)', border: `1px solid ${C.accent}66`, borderRadius: 8, padding: '5px 12px'}}>
			{text}
		</div>
	);
};
// the message box of a new chat, with room around it
const composer = (clip: 'cfind' | 'cwalk'): Cam[] => {
	const m = box(clip, 'message');
	const cx = m[0] + m[2] / 2;
	return [
		{t: 0, r: [cx - 800, m[1] - 330, 1600]},
		{t: 1.7, d: 1.6, r: [cx - 610, m[1] - 215, 1220]},
	];
};

// ------------------------------------------------------------------------------------------------ 1. the question, typed into Claude
export const Ask3: React.FC = () => {
	const {end} = useT();
	const M = cap.cfind.marks;
	return (
		<SceneFade inF={0}>
			<Head tag="SOFT YES · IN CLAUDE" items={[{t: 0, text: 'Raising a round? Ask Soft Yes, in Claude.'}]} />
			<Stage>
				<Shot clip="cfind" segs={[[0, end, M.type - 0.35, M.sent + 0.2]]} cams={composer('cfind')} bg={WHITE} />
			</Stage>
		</SceneFade>
	);
};

// ------------------------------------------------------------------------------------------------ 2. the search draws itself in the chat
export const Draw3: React.FC = () => {
	const {end} = useT();
	const M = cap.cfind.marks;
	const [, c1, c2, c3, c4] = cues('draw');
	const led = box('cfind', 'ledger');
	const st = box('cfind', 'stage');
	const rd = box('cfind', 'read');
	const via = box('cfind', 'via');
	const inv0 = box('cfind', 'inv0');
	const invN = box('cfind', 'invN');
	const sig0 = box('cfind', 'sig0');
	const rows: [number, number] = [inv0[1] - 6, invN[1] + invN[3] - inv0[1] + 12];
	const base: Rect = [led[0] - 33, led[1] - 9, 1170]; // the counts, the graph and the line under it; Claude's own words stay below the frame
	const segs: Seg[] = [
		...play(0, c1.s, M.card - 0.15, M.cos + 1.0), // Cala is asked; the companies it names
		...play(c1.s, c2.s, M.cos + 1.0, M.invs + 1.25), // their investors
		...play(c2.s, c3.s, M.invs + 1.25, M.read - 0.05), // the rounds investors the founder knows sat in
		[c3.s, end, M.read - 0.05], // each investor's own record, then the count: at its real speed
	];
	const tDone = c3.s + (M.done - (M.read - 0.05));
	const cams: Cam[] = [
		{t: 0, r: [206, box('cfind', 'head')[1] - 20, 1510]}, // the whole card as it arrives
		{t: Math.min(c1.s - 0.3, 3.0), d: 1.2, r: base},
		{t: c2.s + 1.4, d: 1.1, r: [392, st[1] + 1, 850]}, // closer: the graph alone, from its headings to the last row
		{t: c3.s + 0.7, d: 1.0, r: base}, // back out: the dots, and under them the record or page being read
	];
	const his: Hi[] = [
		{box: rd, from: 0.45, to: Math.min(c1.s - 0.3, 3.0) - 0.9, pad: -3, color: GREEN},
		{box: [inv0[0] - 10, rows[0], 320, rows[1]], from: said('draw', 1, 'who') - 0.2, to: c2.s - 0.1, pad: 0, color: GREEN},
		{box: via, from: c2.s + 0.25, to: c3.s - 0.1, pad: 4, color: GREEN},
		{box: [sig0[0] - 12, rows[0], sig0[2] + 24, rows[1]], from: said('draw', 3, 'does') - 0.2, to: c4.s - 0.2, pad: 0, color: GREEN},
		{box: rd, from: c3.s + 1.2, to: said('draw', 3, 'does') - 0.3, pad: -3, color: GREEN},
		{box: box('cfind', 'cell0'), from: c4.s + 0.3, to: end + 1, pad: -4, color: GREEN},
		{box: box('cfind', 'cell3'), from: Math.max(said('draw', 4, 'none') - 0.1, tDone), to: end + 1, pad: -4, color: GREEN},
	];
	return (
		<SceneFade>
			<Head
				tag="FIND INVESTORS"
				items={[
					{t: 0, text: 'Cala’s graph is asked for companies like yours'},
					{t: c1.s, text: 'Their rounds, and who invested'},
					{t: c2.s, text: 'The rounds joined by investors you know'},
					{t: c3.s, text: 'Each investor’s own record in Cala'},
					{t: c4.s, text: `${num(FIND.ledger[0], /([\d,]+) facts/)} facts from Cala · 0 from a language model`},
				]}
			/>
			<Stage>
				<Shot clip="cfind" segs={segs} cams={cams} his={his} bg={WHITE} />
			</Stage>
			<Chip from={0.15} to={3.0} text={`the card came ${Math.round(M.card - M.sent)} s after the message`} />
		</SceneFade>
	);
};

// ------------------------------------------------------------------------------------------------ 3. the list: a lead with the page's sentence, and a way in
export const List3: React.FC = () => {
	const {end} = useT();
	const M = cap.clist.marks;
	const [, c1] = cues('list');
	const tWay = c1.s - 0.5;
	const row = box('clist', 'way_row');
	return (
		<SceneFade>
			<Head
				tag="THE LIST"
				items={[
					{t: 0, text: `1 · ${LIST.leads[0].name}: the page says it led`},
					{t: c1.s - 0.1, text: `${LIST.way.name}: ${num(LIST.way.line, /Sat in (\d+)/)} rounds with an investor you know`},
				]}
			/>
			<Stage>
				<Shot
					clip="clist"
					segs={[
						[0, tWay, 0.3, M.way - 1.0],
						[tWay, end, M.way - 1.0],
					]}
					cams={[
						{t: 0, r: [392, box('clist', 'head1')[1] - 30, 1136]},
						{t: tWay + 1.7, d: 0.8, r: [392, row[1] - 26, 1136]},
					]}
					his={[
						{box: box('clist', 'line1'), from: said('list', 0, 'led') - 0.25, to: said('list', 0, "cala's") - 0.3, pad: 5, color: GREEN},
						{box: box('clist', 'proof'), from: said('list', 0, "cala's") - 0.3, to: tWay + 0.4, pad: 4, color: GREEN},
						{box: box('clist', 'way_line'), from: said('list', 1, 'sat') + 0.5, to: end + 1, pad: 5, color: GREEN},
					]}
					bg={WHITE}
				/>
			</Stage>
		</SceneFade>
	);
};

// ------------------------------------------------------------------------------------------------ 4. the soft yes: who led the rounds they joined, by the page
export const Soft3: React.FC = () => {
	const {end} = useT();
	const M = cap.cwalk.marks;
	const [, c1, c2] = cues('soft');
	const tCard = c1.s - 0.3;
	const tDone = tCard + (M.done - (M.card - 0.1)); // the card plays at its real speed
	const led = box('cwalk', 'ledger');
	const chk = /(\d+) pages read\. (\d+) “led” claims hold word for word, (\d+) do not/.exec(WALK.read) || [];
	return (
		<SceneFade>
			<Head
				tag="THE SOFT YES"
				items={[
					{t: 0, text: '“We’re in, if you find a lead.”'},
					{t: c1.s, text: 'The rounds they joined, and who led them'},
					{t: c2.s, text: `${chk[1]} pages read · ${chk[2]} “led” hold · ${chk[3]} do not`},
				]}
			/>
			<Stage>
				<Shot clip="cwalk" to={tCard} segs={[[0, tCard, M.type - 0.3, M.sent + 0.3]]} cams={composer('cwalk')} bg={WHITE} />
				<Shot
					clip="cwalk"
					from={tCard}
					segs={[[tCard, end, M.card - 0.1]]}
					cams={[{t: 0, r: [392, led[1] - 17, 1136]}]}
					his={[
						{box: box('cwalk', 'read'), from: Math.max(said('soft', 2, 'forty') - 0.5, tDone - 0.6), to: end + 1, pad: -3, color: GREEN},
						{box: box('cwalk', 'cell1'), from: Math.max(said('soft', 2, 'two') - 0.2, tDone + 0.2), to: end + 1, pad: -4, color: AMBER},
					]}
					bg={WHITE}
				/>
			</Stage>
			<Chip from={tCard + 0.15} to={tCard + 3.0} text={`the card came ${Math.round(M.card - M.sent)} s after the message`} />
		</SceneFade>
	);
};

// ------------------------------------------------------------------------------------------------ 5. the ask, written in the card
export const Draft3: React.FC = () => {
	const {end} = useT();
	const M = cap.cdraft.marks;
	const [, c1, c2] = cues('draft');
	// the clip runs at its real speed; the button is pressed just before the voice says so
	const tPress = c1.s - 0.25;
	const start = Math.max(0, M.draft - tPress);
	const tAsk = tPress + (M.ask - M.draft) + 0.15; // the ask is there; the still moment before the chat scrolls to it is cut
	const tFacts = c2.s - 0.15; // cut to the list of facts
	const lead = DRAFT.leads[0];
	const door = num(lead.door, /^(.+?) opens the door/);
	return (
		<SceneFade>
			<Head
				tag="THE ASK"
				items={[
					{t: 0, text: `${lead.name}: ${door} was in the round it led`},
					{t: c1.s - 0.1, text: `One click: the ask to ${door}`},
					{t: c2.s - 0.1, text: 'Every fact in it, and where it is from'},
				]}
			/>
			<Stage>
				<Shot
					clip="cdraft"
					to={tFacts}
					segs={[
						[0, tAsk, start],
						[tAsk, tFacts, M.ask + 0.7],
					]}
					cams={[
						{t: 0, r: [392, box('cdraft', 'head1')[1] - 30, 1136]},
						{t: tAsk + 1.25, d: 1.25, r: [420, box('cdraft', 'ask')[1] - 30, 1130]},
					]}
					his={[
						{box: box('cdraft', 'proof'), from: said('draft', 0, 'led') - 0.2, to: said('draft', 0, 'so') - 0.2, pad: 4, color: GREEN},
						{box: box('cdraft', 'door'), from: said('draft', 0, 'so') - 0.2, to: tPress - 0.6, pad: 5, color: GREEN},
						{box: box('cdraft', 'button'), from: tPress - 0.6, to: tPress + 0.2, pad: 3, color: GREEN},
					]}
					bg={WHITE}
				/>
				<Shot
					clip="cdraft"
					from={tFacts}
					segs={[[tFacts, end, M.facts + 0.15]]}
					cams={[{t: 0, r: [420, box('cdraft', 'facts')[1] - 40, 1130]}]}
					his={[
						{box: box('cdraft', 'facts'), from: tFacts + 0.35, to: end - 1.5, pad: 6, color: GREEN},
						{box: box('cdraft', 'gmail'), from: end - 1.5, to: end + 1, pad: 4, color: GREEN},
					]}
					bg={WHITE}
				/>
			</Stage>
		</SceneFade>
	);
};

// ------------------------------------------------------------------------------------------------ 6. close
export const Close3: React.FC = () => {
	const {frame, t} = useT();
	const b1 = pop(frame, 2, 16, 0.7);
	const b2 = soft(frame, F(said('close', 0, 'find') - 0.15));
	const b3 = soft(frame, F(said('close', 0, 'claude') - 0.1));
	const draw = interpolate(t, [0.05, 0.8], [0, 1], {...clamp, easing: ease.out});
	return (
		<SceneFade inF={6} outF={0}>
			<AbsoluteFill style={{fontFamily: SANS, alignItems: 'center', justifyContent: 'center', paddingBottom: 30}}>
				<div style={{display: 'flex', alignItems: 'center', gap: 34, transform: `scale(${0.95 + 0.05 * b1})`, opacity: Math.min(1, b1 * 1.5)}}>
					<Mark size={104} draw={draw} />
					<div style={{fontSize: 132, fontWeight: 700, letterSpacing: -5.5, color: C.text, lineHeight: 1}}>Soft Yes</div>
				</div>
				<div style={{marginTop: 46, fontSize: 70, fontWeight: 600, letterSpacing: -2.2, color: C.text, opacity: b2, transform: `translateY(${(1 - b2) * 16}px)`}}>
					Find your investors in <span style={{color: C.accent}}>Cala’s graph</span>, in Claude.
				</div>
				<div style={{marginTop: 56, fontFamily: MONO, fontSize: 44, fontWeight: 500, color: C.text, padding: '14px 36px', borderRadius: 14, border: `1px solid ${C.line2}`, background: 'rgba(255,255,255,0.05)', opacity: b3, transform: `translateY(${(1 - b3) * 12}px)`}}>soft-yes.fly.dev</div>
				<div style={{marginTop: 40, fontSize: 27, fontWeight: 500, color: C.dimmer, letterSpacing: -0.2, opacity: b3}}>Facts from Cala’s graph and the pages it cites · 0 from a language model</div>
			</AbsoluteFill>
		</SceneFade>
	);
};

export const SCENES3: Record<Scene3, React.FC> = {ask: Ask3, draw: Draw3, list: List3, soft: Soft3, draft: Draft3, close: Close3};
