import {Easing, continueRender, delayRender, interpolate, spring} from 'remotion';
import {MONO_WOFF2, SANS_WOFF2} from './assets.gen';

// The product's own typeface and colours, so the film and the screens it shows read as one thing.
// The fonts are inlined (scripts/make-assets.mjs): a render makes no network request for them.
export const SANS = 'Schibsted Grotesk Film';
export const MONO = 'JetBrains Mono Film';
if (typeof document !== 'undefined') {
	for (const [family, data, weight] of [
		[SANS, SANS_WOFF2, '400 900'],
		[MONO, MONO_WOFF2, '100 800'],
	] as const) {
		const face = new FontFace(family, `url(data:font/woff2;base64,${data}) format('woff2')`, {weight});
		const handle = delayRender(`font ${family}`);
		face.load().then(() => {
			document.fonts.add(face);
			continueRender(handle);
		});
	}
}

export const FPS = 30;
export const W = 1920;
export const H = 1080;

export const C = {
	bg: '#0A0A0A', // the product's page colour, sampled from the capture
	panel: '#111111',
	line: 'rgba(255,255,255,0.09)',
	line2: 'rgba(255,255,255,0.16)',
	text: '#F5F5F3',
	dim: '#A3A39E',
	dimmer: '#6E6E69',
	accent: '#86EFAC',
	accentSoft: 'rgba(134,239,172,0.14)',
	amber: '#F2C063',
	amberSoft: 'rgba(242,192,99,0.14)',
};

export const ease = {
	out: Easing.bezier(0.16, 1, 0.3, 1),
	inOut: Easing.bezier(0.65, 0, 0.35, 1),
};
export const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
export const lerp = (f: number, from: number, to: number, a: number, b: number, e: (t: number) => number = ease.out) =>
	interpolate(f, [from, to], [a, b], {...clamp, easing: e});
export const pop = (frame: number, at: number, damping = 14, mass = 0.6) => spring({frame: frame - at, fps: FPS, config: {damping, mass, stiffness: 170}});
export const soft = (frame: number, at: number) => spring({frame: frame - at, fps: FPS, config: {damping: 200}, durationInFrames: 22});
