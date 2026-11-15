import React from 'react';
import {AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {type Box, type Scene3, box, cap, cut3} from './data';
import logosJson from './data/logos.json';
import {C, FPS, MONO, SANS, clamp, ease, pop, soft} from './theme';
import {type Cam, type Hi, type Seg, ClipFrame, Head, Mark, SceneFade, Shot, Stage, WIN} from './ui';

// The cut made inside Claude: Soft Yes as a connector, its cards drawn in the chat.
// Every clip is a recording of claude.ai (film/capture/claude_shots.py); every number is read from the card.
// The order is the founder's: who do I raise from (the search, the eight signals a row), the first investor opened
// (its signals with their data, its latest rounds in Cala, who it invests with), the way in walked link by link,
// and the soft yes as one short beat at the end.
const {cues, said} = cut3;
const useT = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();
	return {frame, t: frame / FPS, end: durationInFrames / FPS};
};
const F = (s: number) => Math.round(s * FPS);
const GREEN = '#15803D'; // outlines that read on Claude's white page
const MARKER = '#BBF7D0'; // a highlighter drawn over a line of the page
const WHITE = '#FFFFFF';
const num = (s: string, re: RegExp) => (re.exec(s || '') || [])[1] || '';

// Pointer moves and scrolls of one recording, each started at a word of the voice and played at its real speed. The
// recording holds still between them, so the still seconds are cut or held as the voice needs. A move that would start
// before the one before it is over starts when that one ends: nothing is ever sped up.
type Beat = [k: string, at: number | null, from: number, to: number]; // at null: right after the beat before
const track = (bs: Beat[]) => {
	const segs: Seg[] = [];
	const at: Record<string, {a: number; b: number}> = {};
	let t = 0;
	for (const [k, want, from, to] of bs) {
		const a = Math.max(want ?? t + 0.22, t);
		const b = a + (to - from);
		segs.push([a, b, from, to]);
		at[k] = {a, b};
		t = b;
	}
	return {segs, at};
};

// The team's own clips (scripts/team-in.py), in the film's window like everything else: the cold open's tile becomes that
// window, and the team is in it. Their sound is a line of the film (src/data/vo3.json).
const TeamClip: React.FC<{file: string}> = ({file}) => {
	const {frame} = useT();
	const {durationInFrames} = useVideoConfig();
	return (
		<Stage>
			<AbsoluteFill style={{background: '#000'}}>
				<ClipFrame file={file} frame={Math.min(frame, durationInFrames - 1)} w={WIN.w} h={WIN.h} />
			</AbsoluteFill>
		</Stage>
	);
};
// What this film is, said over the team: someone who looks away for ten seconds still knows.
export const Team3: React.FC = () => (
	<>
		<Head tag="SOFT YES" items={[{t: 0.25, text: 'Who to raise from, and the way in. In Claude, from Cala’s graph.'}]} />
		<TeamClip file="team/open.mp4" />
	</>
);
export const Thanks3: React.FC = () => (
	<SceneFade inF={5} outF={0}>
		<Head tag="SOFT YES" items={[{t: 0, text: 'soft-yes.fly.dev'}]} />
		<TeamClip file="team/thanks.mp4" />
	</SceneFade>
);

const FIND = cap.cfind.facts;

// The line above the stage with a tag that changes: one part for each thing the scene shows.
const Heads: React.FC<{parts: {from: number; tag: string; items: {t: number; text: string}[]}[]}> = ({parts}) => {
	const {end} = useT();
	return (
		<>
			{parts.map((p, i) => {
				const from = Math.max(0, F(p.from));
				const to = i + 1 < parts.length ? F(parts[i + 1].from) : F(end) + 1;
				return (
					<Sequence key={i} from={from} durationInFrames={Math.max(1, to - from)} layout="none">
						<Head tag={p.tag} items={p.items.map((it) => ({...it, t: Math.max(0, it.t - from / FPS)}))} />
					</Sequence>
				);
			})}
		</>
	);
};
// A small note above the stage, on the right: what was cut out, said plainly.
const Chip: React.FC<{from: number; to: number; text: string}> = ({from, to, text}) => {
	const {t} = useT();
	const o = Math.min(interpolate(t, [from, from + 0.2], [0, 1], clamp), interpolate(t, [to - 0.25, to], [1, 0], clamp));
	if (o <= 0) return null;
	return (
		<div style={{position: 'absolute', right: 1920 - WIN.x - WIN.w, top: WIN.y - 50, opacity: o, fontFamily: MONO, fontSize: 23, fontWeight: 700, color: C.accent, background: 'rgba(10,10,10,0.86)', border: `1px solid ${C.accent}66`, borderRadius: 8, padding: '5px 12px'}}>
			{text}
		</div>
	);
};
// The part of the page next to what the shot is about, faded to the page's white: the shot is a close look at one thing,
// and a column or a block cut by the frame's edge reads as a mistake. `at` is where the white is whole, in the window's pixels.
const Veil: React.FC<{side: 'right' | 'bottom'; at: number; from: number; to?: number; fade?: number; edge?: number}> = ({side, at, from, to = 1e9, fade = 0.5, edge = 46}) => {
	const {t} = useT();
	const o = Math.min(interpolate(t, [from, from + fade], [0, 1], clamp), interpolate(t, [to - fade, to], [1, 0], clamp));
	if (o <= 0) return null;
	return side === 'right' ? (
		<div style={{position: 'absolute', left: at - edge, top: 0, right: 0, bottom: 0, opacity: o, background: `linear-gradient(to right, rgba(255,255,255,0) 0, #fff ${edge}px)`}} />
	) : (
		<div style={{position: 'absolute', left: 0, right: 0, top: at - edge, bottom: 0, opacity: o, background: `linear-gradient(to bottom, rgba(255,255,255,0) 0, #fff ${edge}px)`}} />
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

// ------------------------------------------------------------------------------------------------ 0. the cold open: its picture is drawn over the film (Film.tsx), the voice says the first line over it
export const Open3: React.FC = () => null;

// ------------------------------------------------------------------------------------------------ 1. the question, typed into Claude: the end of the typing and the click on Send, at their real speed
// ("So I asked Claude" answers the team's last words: "something we could plug into our Claude")
export const Ask3: React.FC = () => {
	const {end} = useT();
	const M = cap.cfind.marks;
	return (
		<SceneFade inF={0}>
			<Head tag="SOFT YES · IN CLAUDE" items={[{t: 0, text: 'Say what you build, your stage and where you are'}]} />
			<Stage>
				<Shot clip="cfind" segs={[[0, end, M.sent + 0.25 - end]]} cams={composer('cfind')} bg={WHITE} />
			</Stage>
		</SceneFade>
	);
};

// ------------------------------------------------------------------------------------------------ 2. the card draws at its real speed: companies like mine, then the investors in their rounds
export const Find3: React.FC = () => {
	const {end} = useT();
	const M = cap.cfind.marks;
	const led = box('cfind', 'ledger');
	const inv0 = box('cfind', 'inv0');
	const invN = box('cfind', 'invN');
	const cam: [number, number, number] = [345, led[1] - 132, 1250];
	const from = M.card + 0.5; // the card is there: the companies come in as the voice says "companies"
	const tThen = said('find', 0, 'then') - 0.1;
	const tNone = said('find', 0, 'none') - 0.15;
	return (
		<SceneFade>
			<Head
				tag="FROM CALA’S GRAPH"
				items={[
					{t: 0, text: `${num(FIND.head, /around (\d+) companies/)} companies like mine`},
					{t: tThen, text: `The ${num(FIND.head, /(\d+) investors around/)} investors in their rounds`},
					{t: tNone, text: 'From a language model: 0 facts'},
				]}
			/>
			<Stage>
				<Shot
					clip="cfind"
					segs={[[0, end, from]]}
					cams={[
						{t: 0, r: cam},
						{t: end, d: end, r: [cam[0] + 12, cam[1] + 6, cam[2] - 24]},
					]}
					his={[
						{box: box('cfind', 'cell0'), from: M.cos - from + 0.2, to: tThen + 0.2, pad: -4, color: GREEN},
						{box: [inv0[0], inv0[1] - 4, inv0[2], invN[1] + invN[3] - inv0[1] + 8], from: said('find', 0, '65') + 0.1, to: tNone - 0.1, pad: 0, color: GREEN},
						{box: box('cfind', 'cell3'), from: tNone + 0.1, to: end + 1, pad: -4, color: GREEN},
					]}
					bg={WHITE}
				/>
				<Veil side="bottom" at={WIN.h} from={-1} />
			</Stage>
			<Chip from={0.15} to={3.0} text={`the card took ${Math.round(M.card - M.sent)} s`} />
		</SceneFade>
	);
};

// ------------------------------------------------------------------------------------------------ 3. how to pick: the eight signals a row, the first investor opened, its latest rounds, the way in
// One recording, one take: the pointer goes where the voice is. Each outline is the thing the voice has just named.
export const Inv3: React.FC = () => {
	const {end} = useT();
	const M = cap.cinv.marks;
	const X = cap.cinv.facts;
	const B = (n: string) => box('cinv', n);
	const s = (line: number, w?: string, nth = 0) => said('inv', line, w, nth);
	const [, c1, c2, c3] = cues('inv');
	const {segs, at} = track([
		['enter', 0, M.sig_a_go - 0.1, M.sig_a + 0.08], // the pointer comes in to the first investor's signals
		['sig', s(0, 'eight') - 0.3, M.sig_go, M.sig + 0.08], // along the eight
		['row1', s(0, 'all') - 0.35, M.row1_at_go, M.row1_at + 0.08], // down the rows under it: every investor has them
		['row2', null, M.row2_at_go, M.row2_at + 0.08],
		['row3', null, M.row3_at_go, M.row3_at + 0.08],
		['open', c1.s - 1.0, M.open_go - 0.03, M.open + 1.3], // the first one is opened as the voice names it
		['lately', s(1, 'has') - 0.25, M.s_lately_go, M.s_lately + 0.08],
		['stage', s(1, 'led') - 0.7, M.s_stage_go, M.s_stage + 0.08],
		['fund', s(1, 'closed') - 0.45, M.s_fund_go, M.s_fund + 0.08],
		['lat', c2.s - 0.85, M.lat_down - 0.03, M.lat], // down to its latest rounds
		['in0', s(2, 'two') - 0.4, M.lat_in0_go, M.lat_in0 + 0.08],
		['in1', null, M.lat_in1_go, M.lat_in1 + 0.08],
		['cos', s(2, 'invested') - 0.45, M.cos_go, M.cos + 0.08],
		['chain', c3.s - 0.6, M.chain_down - 0.03, M.chain], // down to the way in
		['n0', s(3, 'cala') - 0.7, M.n0_go, M.n0 + 0.08],
		['n1', s(3, 'kfund') - 0.45, M.n1_go, M.n1 + 0.08],
		['n2', s(3, 'fj') - 0.45, M.n2_go, M.n2 + 0.08],
		['n3', s(3, 'contrarian') - 0.45, M.n3_go, M.n3 + 0.08],
		['n4', s(3, 'ovni', 1) - 0.45, M.n4_go, M.n4 + 0.08],
		['pg', s(3, 'every') - 0.3, M.pg_go, M.pg + 0.08],
	]);
	const list: [number, number, number] = [392, 174, 1136]; // the list, the open row and its latest rounds all sit at the same height in the chat
	const way: [number, number, number] = [436, B('chain')[1] - 15, 1010]; // closer: the way in
	const chips: Box = [B('sgs0')[0] - 2, B('sgs0')[1], 934, B('sgs0')[3]];
	const chip = (label: string) => B(`sg${(X.chips as string[]).findIndex((c) => c.startsWith(label))}`);
	const why = (label: string) => B(`why${(X.why_ids as Record<string, number>)[label]}`);
	const names = X.chain.names as string[];
	const nameBox = (i: number): Box => [B(`name${i}`)[0] - 4, B(`name${i}`)[1], 44 + names[i].length * 10.8, B(`name${i}`)[3]];
	// the line under a name: what joins it to the next one, up to the mark that says the page was read
	const linkBox = (i: number): Box => {
		const l = B(`link${i}`);
		const pg = cap.cinv.boxes[`pg${i - 1}`];
		return [l[0] + 22, l[1] + 2, pg ? pg[0] - 14 - l[0] - 22 : 102, 27];
	};
	const nameAt = [at.n0.b - 0.3, s(3, 'kfund') - 0.2, s(3, 'fj') - 0.2, s(3, 'contrarian') - 0.2, s(3, 'ovni', 1) - 0.2];
	const linkAt = [s(3, 'their') - 0.1, s(3, 'did') - 0.1, s(3, 'did', 1) - 0.1, s(3, 'coled') - 0.1];
	const g = (b: Box, from: number, to: number, pad = 2): Hi => ({box: b, from, to, pad, color: GREEN});
	const his: Hi[] = [
		// the eight signals, then two of them as the voice asks its two questions
		g(chips, at.sig.a + 0.15, s(0, 'is') - 0.15, 5),
		g(chip('Active now'), s(0, 'investing') - 0.25, s(0, 'is', 1) + 0.1, 4),
		g(chip('Near you'), s(0, 'near') - 0.25, at.open.a + 1.0, 4),
		// the first investor: seven of the eight, the line of each signal the voice reads, the sentence of the page
		g(chips, s(1, 'seven') - 0.15, s(1, 'has') - 0.1, 5),
		g(why('Recent in your field'), at.lately.b - 0.25, s(1, 'which')),
		g(B('proof'), s(1, 'bleu') - 0.2, s(1, 'led') - 0.8),
		g(why('Pre-seed'), s(1, 'led') - 0.1, s(1, 'closed') - 0.2),
		g(why('New fund'), s(1, 'closed'), at.lat.a + 0.1),
		// its latest rounds: all five, the two in my field, who it invests with
		g(B('lat_t'), at.lat.b - 0.35, s(2, 'two') - 0.2, 4),
		...(X.latest_in as number[]).slice(0, 2).map((i, k) => g(B(`lat${i}`), s(2, 'two') - 0.1 + k * 0.45, s(2, 'invested') - 0.35, 1)),
		g([B('cos')[0] - 2, B('cos')[1], 470, B('cos')[3]], s(2, 'invested') - 0.05, at.chain.a + 0.1, 4),
		// the way in: each fund as the voice names it, the round that joins it to the next, then the pages
		...names.map((_, k) => g(nameBox(k), Math.max(nameAt[k], at.chain.b), end + 1, 3)),
		...linkAt.map((t, k): Hi => ({box: linkBox(k), from: Math.max(t, at.chain.b), to: end + 1, pad: 2, color: MARKER, fill: 'light'})),
		...[0, 1, 2].filter((i) => cap.cinv.boxes[`pg${i}`]).map((i) => g(B(`pg${i}`), s(3, 'page') - 0.25 + i * 0.22, end + 1, 3)),
	];
	return (
		<SceneFade>
			<Heads
				parts={[
					{from: 0, tag: 'THE SIGNALS', items: [{t: 0, text: 'Eight signals for each investor, all read from Cala'}]},
					{
						from: c1.s - 0.3,
						tag: 'FIRST ON THE LIST',
						items: [
							{t: c1.s - 0.3, text: `${X.leads[0].name}: ${X.chips_on} of the ${X.chips.length} signals`},
							{t: s(1, 'this') - 0.1, text: 'Nov 2026: co-led Bleu Robotics’s pre-seed'},
							{t: s(1, 'led') - 0.3, text: 'Led 2 of its 3 pre-seeds. $57M fund closed Jun 2025'},
						],
					},
					{
						from: c2.s - 0.4,
						tag: 'RECENT ROUNDS',
						items: [
							{t: c2.s - 0.4, text: `Its last ${X.latest.length} rounds in Cala, each with its date`},
							{t: s(2, 'invested') - 0.3, text: 'Invests with Daphni and Kima, two rounds each'},
						],
					},
					{
						from: c3.s - 0.4,
						tag: 'THE WAY IN',
						items: [
							{t: c3.s - 0.4, text: 'From the Cala team to Ovni, one shared round at a time'},
							{t: s(3, "that's") - 0.2, text: `${names.length - 2} introductions from ${names[1]}, each with its page`},
						],
					},
				]}
			/>
			<Stage>
				<Shot
					clip="cinv"
					segs={segs}
					cams={[
						{t: 0, r: list},
						{t: at.chain.b, d: 1.3, r: way},
					]}
					his={his}
					bg={WHITE}
				/>
				{/* a row cut by the window's lower edge fades out instead */}
				<Veil side="bottom" at={WIN.h} from={-1} />
			</Stage>
		</SceneFade>
	);
};

// ------------------------------------------------------------------------------------------------ 4. the soft yes, short: the two who said yes, the rounds they joined, who led them; then the first of the list
export const Soft3: React.FC = () => {
	const {end} = useT();
	const W = cap.cwalk.marks;
	const S = cap.csoft.marks;
	const led = box('cwalk', 'ledger');
	const L = (n: string) => box('csoft', n);
	const lead = cap.csoft.facts.leads[0];
	const what = /^Led (\S+) (?:\S+ )?(.+?), \w+ \d+$/.exec(lead.line) || []; // "Led Verda $189M Series B, Sep 2026"
	const two = W.rounds - 0.06; // the two who said yes are on the card, and nothing else yet
	const drawn = W.check - 0.05; // the rounds they joined and who led them; no page is open yet
	const tName = said('soft', 0, 'name') - 0.3;
	const tDraw = said('soft', 0, 'and') - 0.1; // the rounds, then who led them, drawn at their real speed
	const tList = tDraw + (drawn - two) + 0.3; // cut to the list under the card
	// measured from the counts above the graph (the card is 1104 wide in the recording)
	const named: Box = [led[0] + 108, led[1] + 236, 172, 130];
	const who: Box = [led[0] + 752, led[1] + 132, 352, 336];
	const camL: [number, number, number] = [410, L('row0')[1] - 4, 1090];
	const h1 = L('head1');
	const door = L('door');
	return (
		<SceneFade>
			<Head
				tag="A SOFT YES"
				items={[
					{t: 0, text: '“Yes, if you find a lead.”'},
					{t: tName, text: 'Name them: who led the rounds they joined'},
					{t: tList, text: `First: ${lead.name} led ${what[1]}’s ${what[2]}`},
				]}
			/>
			<Stage>
				<Shot
					clip="cwalk"
					to={tList + 0.15}
					segs={[
						[0.2, 0.2 + (two - (W.card - 0.1)), W.card - 0.1, two],
						[tDraw, tDraw + (drawn - two), two, drawn],
					]}
					cams={[
						{t: 0, r: [350, led[1] - 132, 1220]},
						{t: tList, d: tList, r: [360, led[1] - 127, 1200]},
					]}
					his={[
						{box: named, from: tName, to: tDraw + 0.4, pad: 2, color: GREEN},
						{box: who, from: tDraw + (W.leads - two) + 0.2, to: tList + 1, pad: 0, color: GREEN},
					]}
					bg={WHITE}
				/>
				<Shot
					clip="csoft"
					from={tList}
					segs={[[tList + 0.25, tList + 0.25 + (S.lead + 0.08 - S.lead_go), S.lead_go, S.lead + 0.08]]}
					cams={[{t: 0, r: camL}]}
					his={[{box: [h1[0] + 40, h1[1] + 4, 640, door[1] + door[3] - h1[1] - 2], from: tList + 0.6, to: end + 1, pad: 2, color: GREEN}]}
					bg={WHITE}
				/>
				{/* the rows under the second one are cut by the window: faded out instead */}
				<Veil side="bottom" at={(L('row1')[1] + L('row1')[3] + 2 - camL[1]) * (WIN.w / camL[2])} from={tList} fade={0.12} edge={16} />
			</Stage>
		</SceneFade>
	);
};

// ------------------------------------------------------------------------------------------------ 5. close: the name, what it answers, where it is
const LOGOS = logosJson as Record<string, {name: string; mono: boolean; body: string}>;
const Logo: React.FC<{k: string}> = ({k}) => (
	<div style={{display: 'flex', alignItems: 'center', gap: 13}}>
		<svg viewBox="0 0 24 24" width={40} height={40} fill={LOGOS[k].mono ? 'currentColor' : undefined} fillRule={LOGOS[k].mono ? 'evenodd' : undefined} style={{color: C.text, flex: 'none'}} dangerouslySetInnerHTML={{__html: LOGOS[k].body}} />
		<div style={{fontSize: 32, fontWeight: 600, letterSpacing: -0.8, color: C.text, whiteSpace: 'nowrap'}}>{LOGOS[k].name}</div>
	</div>
);
export const Close3: React.FC = () => {
	const {frame, t} = useT();
	const b1 = pop(frame, 2, 16, 0.7);
	const draw = interpolate(t, [0.05, 0.8], [0, 1], {...clamp, easing: ease.out});
	const b2 = soft(frame, F(said('close', 0, 'called') + 0.1));
	const b3 = soft(frame, F(said('close', 0, 'add') - 0.15));
	const b4 = soft(frame, F(said('close', 0, 'add') + 0.3));
	const rise = (o: number): React.CSSProperties => ({opacity: o, transform: `translateY(${(1 - o) * 12}px)`});
	return (
		<SceneFade inF={6} outF={0}>
			<AbsoluteFill style={{fontFamily: SANS, alignItems: 'center', paddingTop: 168}}>
				<div style={{display: 'flex', alignItems: 'center', gap: 26, transform: `scale(${0.95 + 0.05 * b1})`, opacity: Math.min(1, b1 * 1.5)}}>
					<Mark size={70} draw={draw} />
					<div style={{fontSize: 88, fontWeight: 700, letterSpacing: -3.6, color: C.text, lineHeight: 1}}>Soft Yes</div>
				</div>
				<div style={{marginTop: 78, textAlign: 'center', ...rise(b2)}}>
					<div style={{fontSize: 58, fontWeight: 700, letterSpacing: -2, color: C.text, lineHeight: 1.15}}>Who to raise from, and who gets you in the door.</div>
					<div style={{marginTop: 22, fontSize: 34, fontWeight: 500, color: C.dim, letterSpacing: -0.5}}>
						Every fact from Cala’s graph. <span style={{color: C.accent}}>None from a language model.</span>
					</div>
				</div>
				<div style={{marginTop: 80, fontFamily: MONO, fontSize: 46, fontWeight: 500, color: C.text, padding: '14px 36px', borderRadius: 14, border: `1px solid ${C.line2}`, background: 'rgba(255,255,255,0.05)', ...rise(b3)}}>soft-yes.fly.dev</div>
				<div style={{marginTop: 64, display: 'flex', alignItems: 'center', gap: 44, ...rise(b4)}}>
					<div style={{fontFamily: MONO, fontSize: 22, fontWeight: 700, letterSpacing: 2.4, color: C.dim, whiteSpace: 'nowrap'}}>ADD IT TO</div>
					{['claude', 'claudecode', 'chatgpt', 'openclaw', 'cursor'].map((k) => (
						<Logo key={k} k={k} />
					))}
				</div>
			</AbsoluteFill>
		</SceneFade>
	);
};

export const SCENES3: Record<Scene3, React.FC> = {team: Team3, thanks: Thanks3, open: Open3, ask: Ask3, find: Find3, inv: Inv3, soft: Soft3, close: Close3};
