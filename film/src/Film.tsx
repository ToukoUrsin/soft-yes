import React from 'react';
import {AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame} from 'remotion';
import {ORDER, type Cut, type SceneId, type VoLine, cut3, timeline, vo} from './data';
import {SceneAsk, SceneAudit, SceneClose, SceneLead, SceneNext, SceneOpen, SceneTurn} from './scenes';
import {SCENES3} from './scenes3';
import {C, FPS, SANS, clamp} from './theme';
import {Backdrop, Grain} from './ui';

// The film: seven scenes, each as long as its narration (src/data.ts builds the timeline from src/data/vo.json).
const SCENES: Record<SceneId, React.FC> = {
	open: SceneOpen,
	turn: SceneTurn,
	lead: SceneLead,
	ask: SceneAsk,
	audit: SceneAudit,
	next: SceneNext,
	close: SceneClose,
};
export const TOTAL = timeline().total;
export const TOTAL3 = cut3.timeline().total;
// every spoken line of a cut with its start, in film seconds
const spokenOf = (cut: Cut) => cut.ORDER.flatMap((id) => cut.timeline().scenes[id].cues.map((c) => ({line: c.line, at: cut.timeline().scenes[id].from / FPS + c.s, scene: id})));

// Burned-in captions: the narration a few words at a time, on the word timing the voice came with.
const chunks = (l: VoLine) => {
	type Wd = (typeof l.words)[number];
	const out: {text: string; s: number; e: number}[] = [];
	const push = (ws: Wd[]) => ws.length && out.push({text: ws.map((w) => w.w).join(' '), s: ws[0].s, e: ws[ws.length - 1].e});
	const len = (ws: Wd[]) => ws.map((w) => w.w).join(' ').length;
	// sentence by sentence; a long one is halved at the comma (or word) nearest its middle, again and again
	const split = (ws: Wd[]) => {
		if (len(ws) <= 38 || ws.length < 4) return push(ws);
		let best = Math.floor(ws.length / 2);
		let bestScore = 1e9;
		for (let i = 2; i <= ws.length - 2; i++) {
			const score = Math.abs(len(ws.slice(0, i)) - len(ws.slice(i))) - (/[,:;]$/.test(ws[i - 1].w) ? 14 : 0);
			if (score < bestScore) {
				bestScore = score;
				best = i;
			}
		}
		split(ws.slice(0, best));
		split(ws.slice(best));
	};
	let cur: Wd[] = [];
	for (const w of l.words) {
		cur.push(w);
		if (/[.?!]$/.test(w.w)) {
			split(cur);
			cur = [];
		}
	}
	split(cur);
	return out;
};
// lines that are already on screen as large type are not captioned a second time
const typeset = (_scene: string, text: string) => text.startsWith('Soft Yes. ');
const Captions: React.FC<{cut: Cut}> = ({cut}) => {
	const frame = useCurrentFrame();
	for (const {line, at, scene} of spokenOf(cut)) {
		if (typeset(scene, line.text)) continue;
		const cs = chunks(line);
		for (let i = 0; i < cs.length; i++) {
			const a = (at + cs[i].s) * FPS - 2;
			// a caption stays until the next one of its line starts, so nothing flickers between words
			const b = i + 1 < cs.length ? (at + cs[i + 1].s) * FPS - 2 : (at + cs[i].e) * FPS + 9;
			if (frame >= a && frame < b) {
				const op = Math.min(interpolate(frame, [a, a + 3], [0, 1], clamp), i + 1 < cs.length ? 1 : interpolate(frame, [b - 4, b], [1, 0], clamp));
				return (
					<div style={{position: 'absolute', left: 0, right: 0, top: 960, display: 'flex', justifyContent: 'center', opacity: op}}>
						<div style={{fontFamily: SANS, fontSize: 52, fontWeight: 700, color: C.text, padding: '10px 32px 14px', borderRadius: 16, whiteSpace: 'nowrap', lineHeight: 1.15, background: 'rgba(6,6,6,0.88)', border: `1px solid ${C.line}`, letterSpacing: -1}}>{cs[i].text}</div>
					</div>
				);
			}
		}
	}
	return null;
};

// the music ducks under the voice
const musicVolOf = (cut: Cut) => {
	const lines = spokenOf(cut);
	const total = cut.timeline().total;
	const voiceOn = (f: number) => lines.some((l) => f >= l.at * FPS - 7 && f <= (l.at + l.line.dur) * FPS + 7);
	return (f: number) => {
		const fade = interpolate(f, [0, 18], [0, 1], clamp) * interpolate(f, [total - 75, total - 3], [1, 0], clamp);
		// eased over a few frames so the duck is not heard as a step
		let v = 0;
		for (let k = -4; k <= 4; k++) v += voiceOn(f + k) ? 0.12 : 0.3;
		return fade * (v / 9);
	};
};

// A cut of the film: its scenes in order, each as long as its narration, with captions, voice and music.
const makeFilm = (cut: Cut, scenes: Record<string, React.FC>): React.FC<{audio?: boolean; captions?: boolean}> => ({audio = true, captions = true}) => {
	const tl = cut.timeline();
	const {ORDER, vo} = cut;
	const spoken = () => spokenOf(cut);
	const musicVol = React.useMemo(() => musicVolOf(cut), []);
	return (
		<AbsoluteFill>
			<Backdrop />
			{ORDER.map((id) => {
				const S = scenes[id];
				return (
					<Sequence key={id} from={tl.scenes[id].from} durationInFrames={tl.scenes[id].dur} name={id}>
						<S />
					</Sequence>
				);
			})}
			<AbsoluteFill style={{pointerEvents: 'none', background: 'radial-gradient(ellipse at 50% 50%, transparent 66%, rgba(0,0,0,0.3) 100%)'}} />
			<Grain />
			{captions ? <Captions cut={cut} /> : null}
			{audio
				? spoken().map((l, i) => (
						<Sequence key={i} from={Math.round(l.at * FPS)} durationInFrames={Math.ceil(l.line.dur * FPS) + 6} name={`vo-${i}`}>
							<Audio src={staticFile(l.line.file)} volume={1} />
						</Sequence>
					))
				: null}
			{audio && vo.music ? <Audio src={staticFile(vo.music)} volume={musicVol} /> : null}
		</AbsoluteFill>
	);
};
export const Film = makeFilm({vo, ORDER, timeline} as unknown as Cut, SCENES);
// the cut made inside Claude
export const Film3 = makeFilm(cut3 as unknown as Cut, SCENES3);
