import capJson from './data/cap.json';
import timing from './data/timing.json';
import voJson from './data/vo.json';
import {FPS} from './theme';

// What the capture saw (film/capture/capture.py) and what the voice says (film/scripts/make-vo.mjs).
export type Box = [number, number, number, number];
export type Clip = {file: string; w: number; h: number; dur: number; marks: Record<string, number>; boxes: Record<string, number[]>; facts: any};
export const cap = capJson as unknown as Record<'walk' | 'check' | 'page' | 'lead' | 'ask' | 'audit' | 'next', Clip>;
export type ClipName = keyof typeof cap;
export const box = (clip: ClipName, name: string): Box => {
	const b = cap[clip].boxes[name];
	if (!b) throw new Error(`cap.json: clip ${clip} has no box ${name}; record that shot again`);
	return b as Box;
};
export const mark = (clip: ClipName, name: string): number => {
	const m = cap[clip].marks[name];
	if (m === undefined) throw new Error(`cap.json: clip ${clip} has no mark ${name}; record that shot again`);
	return m;
};

export type Word = {w: string; s: number; e: number};
export type VoLine = {scene: string; gap: number; text: string; file: string; dur: number; words: Word[]};
export const vo = voJson as {voice: string; music: string | null; lines: VoLine[]};

export type SceneId = 'open' | 'turn' | 'lead' | 'ask' | 'audit' | 'next' | 'close';
// the scenes in order, and the seconds each stays after its last word (src/data/timing.json; the music is cut to the same total)
export const ORDER = timing.order as SceneId[];
const TAIL = timing.tail as Record<SceneId, number>;

// Each line starts `gap` seconds after the line before it in its scene (after the scene start for the first).
export type Cue = {s: number; e: number; line: VoLine};
const build = () => {
	const scenes = {} as Record<SceneId, {cues: Cue[]; dur: number; from: number}>;
	let from = 0;
	for (const id of ORDER) {
		let t = 0;
		const cues: Cue[] = [];
		vo.lines
			.filter((l) => l.scene === id)
			.forEach((line) => {
				const s = t + line.gap;
				t = s + line.dur;
				cues.push({s, e: t, line});
			});
		const dur = Math.ceil((t + TAIL[id]) * FPS);
		scenes[id] = {cues, dur, from};
		from += dur;
	}
	return {scenes, total: from};
};
let built: ReturnType<typeof build> | null = null;
export const timeline = () => (built ??= build());
export const cues = (id: SceneId) => timeline().scenes[id].cues;
// the second, inside its scene, at which a word of a line starts (first word that starts with `word`, case ignored)
export const said = (id: SceneId, line: number, word?: string, nth = 0): number => {
	const c = cues(id)[line];
	if (!c) throw new Error(`scene ${id} has no line ${line}`);
	if (!word) return c.s;
	const hits = c.line.words.filter((w) => w.w.toLowerCase().replace(/[^a-z0-9']/g, '').startsWith(word.toLowerCase()));
	if (!hits[nth]) throw new Error(`scene ${id} line ${line} ("${c.line.text}") has no word "${word}"`);
	return c.s + hits[nth].s;
};
