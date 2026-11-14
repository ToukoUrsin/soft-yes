import React from 'react';
import {Composition} from 'remotion';
import {Film, TOTAL} from './Film';
import {ORDER, timeline} from './data';

export const Root: React.FC = () => (
	<>
		<Composition id="Film" component={Film} durationInFrames={TOTAL} fps={30} width={1920} height={1080} defaultProps={{audio: true, captions: true}} />
		<Composition id="FilmSilent" component={Film} durationInFrames={TOTAL} fps={30} width={1920} height={1080} defaultProps={{audio: false, captions: true}} />
	</>
);
// scene starts, for whoever edits the timing: `npx remotion compositions src/index.ts` prints them
console.log('SCENES ' + ORDER.map((id) => `${id} ${(timeline().scenes[id].from / 30).toFixed(1)}s+${(timeline().scenes[id].dur / 30).toFixed(1)}s`).join(' | ') + ` | total ${(TOTAL / 30).toFixed(1)}s`);
