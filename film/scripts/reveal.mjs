// Prints the second of the film at which the walk has folded into the ranked list (the frame saved as out/screenshot.png).
// Same rule as revealAt() in src/scenes.tsx: `reveal` seconds (src/data/timing.json) after the list line of the first scene starts.
import fs from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const vo = JSON.parse(fs.readFileSync(root + 'src/data/vo.json', 'utf8'));
const timing = JSON.parse(fs.readFileSync(root + 'src/data/timing.json', 'utf8'));
let t = 0;
let start = 0;
const lines = vo.lines.filter((l) => l.scene === timing.order[0]);
lines.forEach((l, i) => {
	const s = t + l.gap;
	t = s + l.dur;
	if (i === lines.length - 1) start = s;
});
console.log((start + timing.reveal).toFixed(2));
