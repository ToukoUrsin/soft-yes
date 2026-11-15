import React from 'react';
import {AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame} from 'remotion';
import {ORDER, type Cut, type SceneId, type VoLine, cut3, timeline, vo} from './data';
import {SceneAsk, SceneAudit, SceneClose, SceneLead, SceneNext, SceneOpen, SceneTurn} from './scenes';
import {SCENES3} from './scenes3';
import {C, FPS, MONO, SANS, clamp} from './theme';
import {Backdrop, ClipFrame, Grain} from './ui';

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
// lines that are already on screen as large type are not captioned a second time: the cold open's line is set in type over it (OpenType)
const typeset = (scene: string, text: string) => scene === 'open' || text.startsWith('Soft Yes. ');
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
	const from = cut.musicFrom?.() ?? 0;
	const on = (f: number, live: boolean) => lines.some((l) => !!(l.line as {live?: boolean}).live === live && f >= l.at * FPS - 7 && f <= (l.at + l.line.dur) * FPS + 7);
	// under the narration the music is low; under the team's own clips (a phone in a loud room) lower still
	const level = (f: number) => (on(f, true) ? 0.06 : on(f, false) ? 0.12 : 0.3);
	return (f: number) => {
		const fade = interpolate(f, [from, from + 18], [0, 1], clamp) * interpolate(f, [total - 75, total - 3], [1, 0], clamp);
		// eased over a few frames so the duck is not heard as a step
		let v = 0;
		for (let k = -4; k <= 4; k++) v += level(f + k);
		return fade * (v / 9);
	};
};

// A cut of the film: its scenes in order, each as long as its narration, with captions, voice and music.
const makeFilm = (cut: Cut, scenes: Record<string, React.FC>, Over?: React.FC<{audio: boolean}>): React.FC<{audio?: boolean; captions?: boolean}> => ({audio = true, captions = true}) => {
	const tl = cut.timeline();
	const {ORDER, vo} = cut;
	const spoken = () => spokenOf(cut);
	const musicVol = React.useMemo(() => musicVolOf(cut), []);
	const mFrom = cut.musicFrom?.() ?? 0; // the film frame the music starts on (musicVol takes film frames)
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
			{Over ? <Over audio={audio} /> : null}
			{captions ? <Captions cut={cut} /> : null}
			{audio
				? spoken().map((l, i) => (
						<Sequence key={i} from={Math.round(l.at * FPS)} durationInFrames={Math.ceil(l.line.dur * FPS) + 6} name={`vo-${i}`}>
							<Audio src={staticFile(l.line.file)} volume={1} />
						</Sequence>
					))
				: null}
			{audio && vo.music ? (
				<Sequence from={mFrom} name="music">
					<Audio src={staticFile(vo.music)} volume={(f) => musicVol(f + mFrom)} />
				</Sequence>
			) : null}
		</AbsoluteFill>
	);
};
export const Film = makeFilm({vo, ORDER, timeline} as unknown as Cut, SCENES);
// The cold open (made in ~/junction/opens: 10.0 s, 24 fps) plays over everything for the length of the scene `open`,
// the film's first. It ends on the film's own window with nothing in it, on the film's own background and vignette, so
// it sits above the vignette and the grain, and its last frame fades out over the next scene (the team, in that
// window), which is already there under it.
const OPEN_FADE = 8;
// The words over it, as the voice says them: the founder's two questions. The open's own corners are kept for type.
const OpenType: React.FC = () => {
	const frame = useCurrentFrame();
	const at = (w: string, nth = 0) => Math.round((cut3.said('open', 0, w, nth) - 0.08) * FPS);
	const row = (from: number): React.CSSProperties => {
		const o = interpolate(frame, [from, from + 7], [0, 1], clamp);
		return {opacity: o, transform: `translateY(${(1 - o) * 10}px)`};
	};
	const big: React.CSSProperties = {fontSize: 62, fontWeight: 700, letterSpacing: -2.2, lineHeight: 1.12, whiteSpace: 'nowrap'};
	const shadow = '0 2px 26px rgba(0,0,0,0.95), 0 0 5px rgba(0,0,0,0.85)';
	const top = interpolate(frame, [6.1 * FPS, 6.45 * FPS], [1, 0], clamp); // gone before the open cuts to the fallen tile
	const low = interpolate(frame, [8.15 * FPS, 8.5 * FPS], [1, 0], clamp); // gone before the tile's face fills the window
	return (
		<AbsoluteFill style={{fontFamily: SANS, color: C.text, textShadow: shadow}}>
			<div style={{position: 'absolute', left: 0, top: 0, width: 1100, height: 420, opacity: top * Number(row(at("i'm")).opacity), background: 'radial-gradient(ellipse at 30% 38%, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.4) 45%, transparent 72%)'}} />
			<div style={{position: 'absolute', left: 96, top: 84, opacity: top}}>
				<div style={{...row(at("i'm")), fontFamily: MONO, fontSize: 22, fontWeight: 700, letterSpacing: 2.4, color: C.accent}}>I’M ABOUT TO RAISE A ROUND</div>
				<div style={{...row(at('who')), ...big, marginTop: 16}}>Who do I raise from?</div>
			</div>
			<div style={{position: 'absolute', left: 96, top: 884, opacity: low}}>
				<div style={{...row(at('and')), ...big}}>And who gets me in the door?</div>
			</div>
		</AbsoluteFill>
	);
};
const Open3Layer: React.FC<{audio: boolean; len: number}> = ({audio, len}) => {
	const frame = useCurrentFrame();
	return (
		<AbsoluteFill style={{opacity: interpolate(frame, [len, len + OPEN_FADE], [1, 0], clamp), background: '#000'}}>
			<ClipFrame file="open/open_clean.mp4" frame={Math.min(frame, len - 1)} w={1920} h={1080} />
			<OpenType />
			{audio ? (
				<Sequence from={0} durationInFrames={len + OPEN_FADE} name="open-sound">
					<Audio src={staticFile('open/open.wav')} volume={(f) => 0.3 * interpolate(f, [len - 4, len + OPEN_FADE], [1, 0], clamp)} />
				</Sequence>
			) : null}
		</AbsoluteFill>
	);
};
const Open3Over: React.FC<{audio: boolean}> = ({audio}) => {
	const {from, dur} = cut3.timeline().scenes.open;
	return (
		<Sequence from={from} durationInFrames={dur + OPEN_FADE} name="open">
			<Open3Layer audio={audio} len={dur} />
		</Sequence>
	);
};
// the cut made inside Claude
export const Film3 = makeFilm(cut3 as unknown as Cut, SCENES3, Open3Over);
