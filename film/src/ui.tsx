import React from 'react';
import {AbsoluteFill, Freeze, OffthreadVideo, cancelRender, continueRender, delayRender, getRemotionEnvironment, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {NOISE_PNG} from './assets.gen';
import {type Box, type ClipName, cap} from './data';
import {C, FPS, MONO, SANS, clamp, ease, soft} from './theme';

export const Backdrop: React.FC = () => {
	const frame = useCurrentFrame();
	const drift = Math.sin(frame / 110) * 5;
	return (
		<AbsoluteFill style={{background: C.bg, overflow: 'hidden'}}>
			<AbsoluteFill
				style={{
					background: `radial-gradient(1200px 760px at ${24 + drift}% 12%, rgba(255,255,255,0.075), transparent 70%), radial-gradient(1000px 640px at ${88 - drift}% 96%, rgba(134,239,172,0.05), transparent 70%)`,
				}}
			/>
			<AbsoluteFill
				style={{
					backgroundImage: 'radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1.2px)',
					backgroundSize: '44px 44px',
					maskImage: 'radial-gradient(ellipse at 50% 45%, black 20%, transparent 78%)',
					WebkitMaskImage: 'radial-gradient(ellipse at 50% 45%, black 20%, transparent 78%)',
				}}
			/>
		</AbsoluteFill>
	);
};

export const Grain: React.FC = () => {
	const frame = useCurrentFrame();
	return (
		<AbsoluteFill style={{pointerEvents: 'none', mixBlendMode: 'overlay', opacity: 0.06}}>
			<AbsoluteFill style={{backgroundImage: `url(data:image/png;base64,${NOISE_PNG})`, backgroundPosition: `${(frame * 137) % 512}px ${(frame * 251) % 512}px`}} />
		</AbsoluteFill>
	);
};

// Scene envelope: a short fade and blur at the scene edges (the backdrop stays, so there is never black).
export const SceneFade: React.FC<{children: React.ReactNode; inF?: number; outF?: number}> = ({children, inF = 9, outF = 8}) => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();
	// inF or outF 0: no fade on that side (the first and the last frame of the film are whole)
	const op = Math.min(inF > 0 ? interpolate(frame, [0, inF], [0, 1], clamp) : 1, outF > 0 ? interpolate(frame, [durationInFrames - outF, durationInFrames], [1, 0], clamp) : 1);
	const blur = (1 - op) * 8;
	return <AbsoluteFill style={{opacity: op, filter: blur > 0.2 ? `blur(${blur}px)` : undefined}}>{children}</AbsoluteFill>;
};

// The product's mark: a hollow circle (the soft yes) joined to a filled dot (the lead).
export const Mark: React.FC<{size?: number; draw?: number}> = ({size = 60, draw = 1}) => {
	const r = size * 0.3;
	const sw = size * 0.085;
	const w = size * 1.9;
	const x1 = r + sw;
	const x2 = w - r - sw;
	const line = interpolate(draw, [0.15, 0.7], [0, 1], clamp);
	const dot = interpolate(draw, [0.6, 1], [0, 1], clamp);
	return (
		<svg width={w} height={size} viewBox={`0 0 ${w} ${size}`} style={{overflow: 'visible'}}>
			<line x1={x1 + r} y1={size / 2} x2={x1 + r + (x2 - r - x1 - r) * line} y2={size / 2} stroke={C.text} strokeWidth={sw * 0.8} strokeLinecap="round" opacity={0.55} />
			<circle cx={x1} cy={size / 2} r={r} fill="none" stroke={C.text} strokeWidth={sw} opacity={interpolate(draw, [0, 0.2], [0, 1], clamp)} />
			<circle cx={x2} cy={size / 2} r={r * (0.4 + 0.6 * dot) * 1.08} fill={C.text} opacity={dot} style={{filter: `drop-shadow(0 0 ${size * 0.35}px rgba(255,255,255,0.4))`}} />
		</svg>
	);
};

// ------------------------------------------------------------------------------------------------ the stage

// The window real footage plays in. 16:9, so a 1920x1080 capture fills it at 0.79x; the camera zooms from there.
// It leaves room under it for captions large enough to read on a phone.
export const WIN = {x: 198, y: 88, w: 1524, h: 857};

export type Seg = [a: number, b: number, from: number, to?: number]; // scene seconds a..b show clip seconds from..to (to omitted: real speed)
export type Cam = {t: number; d?: number; r: [number, number, number]}; // be at rect x, y, width (clip pixels) at second t, after a move of d seconds
export type Hi = {box: Box; from: number; to: number; pad?: number; color?: string; fill?: 'light' | 'dark'}; // fill: a marker drawn over a line of text instead of an outline

const segAt = (segs: Seg[], t: number) => {
	let cur = segs[0];
	for (const s of segs) if (t >= s[0]) cur = s;
	return cur;
};
const clipSec = (segs: Seg[], t: number) => {
	const [a, b, from, to] = segAt(segs, t);
	const k = Math.min(Math.max(t, a), b);
	return to === undefined ? from + (k - a) : from + ((k - a) / Math.max(1e-6, b - a)) * (to - from);
};
const rate = (segs: Seg[], t: number) => {
	const [a, b, from, to] = segAt(segs, t);
	return to === undefined || t > b ? 1 : (to - from) / Math.max(1e-6, b - a);
};
const camAt = (cams: Cam[], t: number) => {
	let [x, y, w] = cams[0].r;
	for (const c of cams.slice(1)) {
		const d = c.d ?? 0.9;
		const k = interpolate(t, [c.t - d, c.t], [0, 1], {...clamp, easing: ease.inOut});
		if (k <= 0) break;
		x += (c.r[0] - x) * k;
		y += (c.r[1] - y) * k;
		w += (c.r[2] - w) * k;
	}
	return {x, y, w};
};
// a camera rect of width w around a box: ax is where the box centre sits across the rect, top the space left above the box
export const fit = (b: Box, w: number, o: {ax?: number; top?: number; minX?: number; maxX?: number} = {}): [number, number, number] => {
	const x = b[0] + b[2] / 2 - w * (o.ax ?? 0.5);
	return [Math.min(Math.max(x, o.minX ?? 0), o.maxX ?? Math.max(0, 1920 - w)), b[1] - (o.top ?? 120), w];
};

// One frame of a recorded clip. In a render it is fetched from Remotion's frame server like <OffthreadVideo> does,
// but tried again when the request is dropped: on a machine where containers come and go, Chrome cancels
// requests in flight on every network change, and one dropped frame would otherwise end the whole render.
export const ClipFrame: React.FC<{file: string; frame: number; w: number; h: number}> = ({file, frame, w, h}) => {
	const style: React.CSSProperties = {position: 'absolute', left: 0, top: 0, width: w, height: h};
	const rendering = getRemotionEnvironment().isRendering;
	const [img, setImg] = React.useState<{src: string; handle: number} | null>(null);
	React.useLayoutEffect(() => {
		if (!rendering) return;
		let gone = false;
		let made: string | null = null;
		const handle = delayRender(`frame ${frame} of ${file}`, {timeoutInMilliseconds: 120000});
		const url = `http://localhost:${(window as unknown as {remotion_proxyPort: number}).remotion_proxyPort}/proxy?src=${encodeURIComponent(new URL(staticFile(file), window.origin).href)}&time=${frame / FPS}&transparent=false&toneMapped=true`;
		(async () => {
			let last: unknown = null;
			for (let attempt = 0; attempt < 25 && !gone; attempt++) {
				try {
					const res = await fetch(url, {cache: 'no-store'});
					if (res.status !== 200) throw new Error(`status ${res.status}`);
					made = URL.createObjectURL(await res.blob());
					if (!gone) setImg({src: made, handle});
					return;
				} catch (err) {
					last = err;
					await new Promise((r) => setTimeout(r, 150 + attempt * 150));
				}
			}
			if (gone) continueRender(handle);
			else cancelRender(new Error(`could not load frame ${frame} of ${file}: ${String(last)}`));
		})();
		return () => {
			gone = true;
			continueRender(handle);
			if (made) URL.revokeObjectURL(made);
		};
	}, [file, frame, rendering]);
	if (!rendering) {
		return (
			<Freeze frame={frame}>
				<OffthreadVideo src={staticFile(file)} muted style={style} />
			</Freeze>
		);
	}
	return img ? <img src={img.src} style={style} onLoad={() => continueRender(img.handle)} onError={() => cancelRender(new Error(`frame ${frame} of ${file} did not decode`))} /> : null;
};

export const Stage: React.FC<{children: React.ReactNode}> = ({children}) => (
	<div
		style={{
			position: 'absolute',
			left: WIN.x,
			top: WIN.y,
			width: WIN.w,
			height: WIN.h,
			borderRadius: 16,
			overflow: 'hidden',
			background: C.bg,
			boxShadow: `0 0 0 1px ${C.line2}, 0 40px 120px rgba(0,0,0,0.6), 0 0 90px rgba(255,255,255,0.045)`,
		}}
	>
		{children}
	</div>
);

// One piece of footage inside the stage: which clip seconds play when, where the camera looks, what is outlined.
export const Shot: React.FC<{clip: ClipName; segs: Seg[]; cams: Cam[]; his?: Hi[]; from?: number; to?: number; label?: string; bg?: string}> = ({clip, segs, cams, his = [], from = 0, to = 1e9, label, bg = C.bg}) => {
	const frame = useCurrentFrame();
	const t = frame / FPS;
	if (t < from - 0.01 || t >= to) return null;
	const info = cap[clip];
	const cf = Math.min(Math.max(0, Math.round(clipSec(segs, t) * FPS)), Math.round(info.dur * FPS) - 1);
	const {x, y, w} = camAt(cams, t);
	const s = WIN.w / w;
	const sp = rate(segs, t);
	const fast = sp >= 1.15; // anything sped up says so
	const spLabel = sp >= 1.95 && Math.abs(sp - Math.round(sp)) < 0.3 ? `${Math.round(sp)}×` : `${sp.toFixed(1)}×`;
	const op = interpolate(t, [from, from + 0.12], [from > 0 ? 0 : 1, 1], clamp);
	return (
		<div style={{position: 'absolute', inset: 0, opacity: op, background: bg}}>
			<div style={{position: 'absolute', left: 0, top: 0, width: info.w, height: info.h, transformOrigin: '0 0', transform: `translate(${-x * s}px, ${-y * s}px) scale(${s})`}}>
				<ClipFrame file={info.file} frame={cf} w={info.w} h={info.h} />
				{his.map((h, i) => {
					const o = Math.min(interpolate(t, [h.from, h.from + 0.25], [0, 1], clamp), interpolate(t, [h.to - 0.2, h.to], [1, 0], clamp));
					if (o <= 0) return null;
					const p = h.pad ?? 6;
					const grow = interpolate(t, [h.from, h.from + 0.35], [10, 0], {...clamp, easing: ease.out}) / s;
					const col = h.color ?? C.accent;
					if (h.fill) {
						const wipe = interpolate(t, [h.from, h.from + 0.4], [0, 1], {...clamp, easing: ease.inOut});
						const out = interpolate(t, [h.to - 0.2, h.to], [1, 0], clamp);
						return (
							<div
								key={i}
								style={{
									position: 'absolute',
									left: h.box[0] - p,
									top: h.box[1] - p,
									width: (h.box[2] + 2 * p) * wipe,
									height: h.box[3] + 2 * p,
									borderRadius: 5 / s,
									background: col,
									mixBlendMode: h.fill === 'light' ? 'multiply' : 'screen',
									opacity: (h.fill === 'light' ? 0.85 : 0.3) * out,
								}}
							/>
						);
					}
					return (
						<div
							key={i}
							style={{
								position: 'absolute',
								left: h.box[0] - p - grow,
								top: h.box[1] - p - grow,
								width: h.box[2] + 2 * (p + grow),
								height: h.box[3] + 2 * (p + grow),
								borderRadius: 12 / s,
								border: `${2.5 / s}px solid ${col}`,
								boxShadow: `0 0 ${26 / s}px ${col}55, inset 0 0 ${18 / s}px ${col}14`,
								opacity: o,
							}}
						/>
					);
				})}
			</div>
			{fast ? (
				<div style={{position: 'absolute', right: 18, top: 16, display: 'flex', alignItems: 'center', gap: 8, fontFamily: MONO, fontSize: 19, fontWeight: 700, color: C.accent, background: 'rgba(10,10,10,0.86)', border: `1px solid ${C.accent}66`, borderRadius: 8, padding: '6px 12px'}}>
					<span style={{fontSize: 14, letterSpacing: -2}}>▶▶</span> {spLabel} speed
				</div>
			) : null}
			{label ? (
				<div style={{position: 'absolute', left: 18, bottom: 16, fontFamily: MONO, fontSize: 19, fontWeight: 500, color: '#111', background: 'rgba(255,255,255,0.92)', border: '1px solid rgba(0,0,0,0.2)', borderRadius: 8, padding: '6px 12px'}}>{label}</div>
			) : null}
		</div>
	);
};

// The line above the stage: a small tag and what the viewer is looking at, changing with the voice.
export const Head: React.FC<{tag: string; items: {t: number; text: string}[]}> = ({tag, items}) => {
	const frame = useCurrentFrame();
	const t = frame / FPS;
	const a = soft(frame, 2);
	return (
		<div style={{position: 'absolute', left: WIN.x, top: 19, width: WIN.w, height: 60, fontFamily: SANS}}>
			<div style={{position: 'absolute', left: 0, top: 9, opacity: a, fontFamily: MONO, fontSize: 17, fontWeight: 700, letterSpacing: 1.6, color: C.accent, padding: '7px 12px', border: `1px solid ${C.accent}55`, borderRadius: 7, background: C.accentSoft, whiteSpace: 'nowrap'}}>{tag}</div>
			{items.map((it, i) => {
				const end = items[i + 1]?.t ?? 1e9;
				const o = Math.min(interpolate(t, [it.t, it.t + 0.28], [0, 1], clamp), interpolate(t, [end - 0.05, end + 0.16], [1, 0], clamp));
				if (o <= 0) return null;
				const dy = interpolate(t, [it.t, it.t + 0.4], [16, 0], {...clamp, easing: ease.out}) - interpolate(t, [end - 0.05, end + 0.16], [0, 10], clamp);
				return (
					<div key={i} style={{position: 'absolute', left: tag.length * 12.4 + 46, top: 0, right: 0, opacity: o, transform: `translateY(${dy}px)`, fontSize: 39, fontWeight: 700, color: C.text, letterSpacing: -1, whiteSpace: 'nowrap', lineHeight: '56px'}}>
						{it.text}
					</div>
				);
			})}
		</div>
	);
};
