import React from 'react';
import {Composition} from 'remotion';
import {Film, Film3, TOTAL, TOTAL3} from './Film';
import {ORDER, cut3, timeline} from './data';

export const Root: React.FC = () => (
	<>
		<Composition id="Film" component={Film} durationInFrames={TOTAL} fps={30} width={1920} height={1080} defaultProps={{audio: true, captions: true}} />
		<Composition id="Film3" component={Film3} durationInFrames={Math.max(1, TOTAL3)} fps={30} width={1920} height={1080} defaultProps={{audio: true, captions: true}} />
		<Composition id="Film3Silent" component={Film3} durationInFrames={Math.max(1, TOTAL3)} fps={30} width={1920} height={1080} defaultProps={{audio: false, captions: true}} />
		<Composition id="FilmSilent" component={Film} durationInFrames={TOTAL} fps={30} width={1920} height={1080} defaultProps={{audio: false, captions: true}} />
	</>
);
// scene starts, for whoever edits the timing: `npx remotion compositions src/index.ts` prints them
console.log('SCENES ' + ORDER.map((id) => `${id} ${(timeline().scenes[id].from / 30).toFixed(1)}s+${(timeline().scenes[id].dur / 30).toFixed(1)}s`).join(' | ') + ` | total ${(TOTAL / 30).toFixed(1)}s`);
console.log('SCENES3 ' + cut3.ORDER.map((id) => `${id} ${(cut3.timeline().scenes[id].from / 30).toFixed(1)}s+${(cut3.timeline().scenes[id].dur / 30).toFixed(1)}s`).join(' | ') + ` | total ${(TOTAL3 / 30).toFixed(1)}s`);
