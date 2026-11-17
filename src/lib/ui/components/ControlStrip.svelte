<script lang="ts">
	import type { BlockReason, CameraControls, ControlId } from '#lib/domain/camera-controls.svelte.ts';
	import type { CameraState, Param } from '#lib/domain/camera-state.svelte.ts';
	import { FOCUS_COARSE, FOCUS_FINE, ISO_STOPS, WB_PRESETS, type Direction } from '#lib/domain/control-values.ts';
	import Icon, { type IconName } from '#lib/ui/components/Icon.svelte';
	import {
		blockText,
		formatAngle,
		formatAperture,
		formatGain,
		formatIso,
		formatKelvin,
		formatSpeed,
		formatTint
	} from '#lib/ui/control-format.ts';

	let { controls, state: cam }: { controls: CameraControls; state: CameraState } = $props();

	type Tile = 'iso' | 'shutter' | 'iris' | 'whiteBalance' | 'focus';
	let open = $state<Tile | null>(null);

	type Mark = 'pending' | 'no-echo' | 'stale' | null;

	function mark(p: Param<unknown> | undefined): Mark {
		if (!p) return null;
		if (p.noEcho) return 'no-echo';
		if (p.status === 'pending') return 'pending';
		if (p.status === 'unknown' && p.confirmed !== undefined) return 'stale';
		return null;
	}

	const MARK_TEXT: Record<Exclude<Mark, null>, string> = {
		pending: 'Sending',
		'no-echo': 'Camera did not confirm',
		stale: 'Last known'
	};

	// ------------------------------------------------------------ derived tile data

	const gainMode = $derived(cam.sensitivityUnit === 'gain');
	const isoParam = $derived<Param<number>>(gainMode ? cam.gainDb : cam.iso);
	const isoText = $derived(
		isoParam.value === undefined ? '--' : gainMode ? formatGain(isoParam.value) : formatIso(isoParam.value)
	);

	const shutterParam = $derived<Param<number> | undefined>(
		cam.shutterUnit === 'angle' ? cam.shutterAngle : cam.shutterUnit === 'speed' ? cam.shutterSpeed : undefined
	);
	const fmtShutter = (v: number) => (cam.shutterUnit === 'speed' ? formatSpeed(v) : formatAngle(v));
	const shutterText = $derived(shutterParam?.value === undefined ? '--' : fmtShutter(shutterParam.value));

	const irisText = $derived(cam.aperture.value === undefined ? '--' : formatAperture(cam.aperture.value, cam.apertureUnits));

	const wb = $derived(cam.whiteBalance.value);
	const wbText = $derived(wb ? `${formatKelvin(wb[0])} ${formatTint(wb[1])}` : '--');

	const tiles = $derived([
		{ id: 'iso' as const, icon: 'iso' as IconName, label: gainMode ? 'Gain' : 'ISO', value: isoText, block: controls.block('iso'), mark: mark(isoParam) },
		{ id: 'shutter' as const, icon: 'shutter' as IconName, label: 'Shutter', value: shutterText, block: controls.block('shutter'), mark: mark(shutterParam) },
		{ id: 'iris' as const, icon: 'iris' as IconName, label: 'Iris', value: irisText, block: controls.block('iris'), mark: mark(cam.aperture) },
		{ id: 'whiteBalance' as const, icon: 'wb' as IconName, label: 'WB', value: wbText, block: controls.block('whiteBalance'), mark: mark(cam.whiteBalance) },
		{ id: 'focus' as const, icon: 'focus' as IconName, label: 'Focus', value: 'Manual', block: controls.block('focus'), mark: null }
	]);

	// The gain-mode ISO tile still opens, to say why it is read-only.
	const opensWhenBlocked = (id: Tile, b: BlockReason | null) => b === null || (id === 'iso' && b === 'gain-mode');

	const afBlock = $derived(controls.block('focus'));

	const current = $derived(tiles.find((t) => t.id === open) ?? null);

	function sent(key: string): boolean {
		return controls.feedback?.key === key && controls.feedback.ok;
	}
	function failed(key: string): boolean {
		return controls.feedback?.key === key && !controls.feedback.ok;
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) open = null;
	}
</script>

<svelte:window onkeydown={onKey} />

{#snippet stepper(id: ControlId, text: string, step: (d: Direction) => unknown, less: string, more: string)}
	{@const b = controls.block(id)}
	<div class="stepper">
		<button class="step" disabled={!!b} aria-label={less} onclick={() => step(-1)}>◀</button>
		<output class="step-value" aria-live="polite">{text}</output>
		<button class="step" disabled={!!b} aria-label={more} onclick={() => step(1)}>▶</button>
	</div>
{/snippet}

<section class="strip" aria-label="Camera controls">
	<button
		class="af"
		class:sent={sent('lens.autoFocus')}
		disabled={!!afBlock}
		aria-label="Autofocus now"
		onclick={() => controls.autoFocus()}
	>
		<Icon name="autofocus" size={26} />
		<span class="af-text">
			<span class="af-label">{failed('lens.autoFocus') ? 'Not sent' : 'Autofocus'}</span>
			{#if afBlock}<span class="af-sub">{blockText(afBlock)}</span>{/if}
		</span>
	</button>
	{#each tiles as t (t.id)}
		<button
			class="tile"
			class:active={open === t.id}
			class:blocked={!!t.block}
			disabled={!opensWhenBlocked(t.id, t.block)}
			aria-expanded={open === t.id}
			onclick={() => (open = open === t.id ? null : t.id)}
		>
			<span class="tile-label"><Icon name={t.icon} size={18} />{t.label}</span>
			<span class="tile-value">{t.value}</span>
			<span class="tile-sub {t.mark ?? ''}">
				{t.block ? blockText(t.block) : t.mark ? MARK_TEXT[t.mark] : ' '}
			</span>
		</button>
	{/each}
</section>

{#if open && current}
	<button class="scrim" aria-label="Close" tabindex="-1" onclick={() => (open = null)}></button>
	<div class="sheet" role="dialog" aria-label={current.label}>
		<header class="sheet-head">
			<div>
				<div class="sheet-title">{current.label}</div>
				<div class="sheet-sub {current.mark ?? ''}">
					{current.block ? blockText(current.block) : current.mark ? MARK_TEXT[current.mark] : 'From camera'}
				</div>
			</div>
			<button class="close" onclick={() => (open = null)}>Done</button>
		</header>

		{#if open === 'iso'}
			{#if gainMode}
				<p class="note">The camera reports gain ({isoText}) instead of ISO. Switch it to ISO on the camera to set it here.</p>
			{:else}
				{@render stepper('iso', isoText, (d) => controls.stepIso(d), 'Lower ISO', 'Higher ISO')}
				<div class="options">
					{#each ISO_STOPS as v (v)}
						<button
							class="opt"
							class:on={isoParam.value === v}
							aria-pressed={isoParam.value === v}
							disabled={!!controls.block('iso')}
							onclick={() => controls.setIso(v)}>{formatIso(v)}</button
						>
					{/each}
				</div>
				{#if isoParam.value !== undefined && !ISO_STOPS.includes(isoParam.value)}
					<p class="note">The camera is at ISO {isoParam.value}, which is not in this list.</p>
				{/if}
			{/if}
		{:else if open === 'shutter'}
			{@render stepper(
				'shutter',
				shutterText,
				(d) => controls.stepShutter(d),
				cam.shutterUnit === 'speed' ? 'Longer shutter' : 'Smaller angle',
				cam.shutterUnit === 'speed' ? 'Shorter shutter' : 'Larger angle'
			)}
			<div class="options">
				{#each controls.shutterOptions as v (v)}
					<button
						class="opt"
						class:on={shutterParam?.value === v}
						aria-pressed={shutterParam?.value === v}
						disabled={!!controls.block('shutter')}
						onclick={() => controls.setShutter(v)}>{fmtShutter(v)}</button
					>
				{/each}
			</div>
			{#if shutterParam?.value !== undefined && !controls.shutterOptions.includes(shutterParam.value)}
				<p class="note">The camera is at {shutterText}, which is not in this list.</p>
			{/if}
		{:else if open === 'iris'}
			{@render stepper('iris', irisText, (d) => controls.stepIris(d), 'Open one third stop', 'Close one third stop')}
			<button
				class="action"
				class:sent={sent('lens.autoAperture')}
				class:failed={failed('lens.autoAperture')}
				disabled={!!controls.block('autoIris')}
				onclick={() => controls.autoIris()}
			>
				{sent('lens.autoAperture') ? 'Auto iris sent' : failed('lens.autoAperture') ? 'Not sent' : 'Auto iris'}
			</button>
		{:else if open === 'whiteBalance'}
			<div class="pair">
				<div>
					<div class="field-label">Kelvin</div>
					{@render stepper('whiteBalance', wb ? formatKelvin(wb[0]) : '--', (d) => controls.stepKelvin(d), 'Cooler, fewer Kelvin', 'Warmer, more Kelvin')}
				</div>
				<div>
					<div class="field-label">Tint</div>
					{@render stepper('whiteBalance', wb ? formatTint(wb[1]) : '--', (d) => controls.stepTint(d), 'Tint towards green', 'Tint towards magenta')}
				</div>
			</div>
			<div class="options presets">
				{#each WB_PRESETS as p (p.kelvin)}
					<button
						class="opt"
						class:on={wb?.[0] === p.kelvin}
						aria-pressed={wb?.[0] === p.kelvin}
						disabled={!!controls.block('whiteBalance')}
						onclick={() => controls.setKelvin(p.kelvin)}
					>
						<span>{formatKelvin(p.kelvin)}</span><small>{p.label}</small>
					</button>
				{/each}
			</div>
			<button
				class="action"
				class:sent={sent('video.autoWhiteBalance')}
				class:failed={failed('video.autoWhiteBalance')}
				disabled={!!controls.block('autoWhiteBalance')}
				onclick={() => controls.autoWhiteBalance()}
			>
				{sent('video.autoWhiteBalance') ? 'Auto WB sent' : failed('video.autoWhiteBalance') ? 'Not sent' : 'Auto white balance'}
			</button>
		{:else if open === 'focus'}
			{@const b = controls.block('focus')}
			<button
				class="action big"
				class:sent={sent('lens.autoFocus')}
				class:failed={failed('lens.autoFocus')}
				disabled={!!b}
				onclick={() => controls.autoFocus()}
			>
				{sent('lens.autoFocus') ? 'Autofocus sent' : failed('lens.autoFocus') ? 'Not sent' : 'Autofocus'}
			</button>
			<div class="field-label">Nudge {sent('lens.focus') ? '· sent' : failed('lens.focus') ? '· not sent' : ''}</div>
			<div class="nudge">
				<button disabled={!!b} aria-label="Focus near, big step" onclick={() => controls.nudgeFocus(-FOCUS_COARSE)}>◀◀</button>
				<button disabled={!!b} aria-label="Focus near, small step" onclick={() => controls.nudgeFocus(-FOCUS_FINE)}>◀</button>
				<button disabled={!!b} aria-label="Focus far, small step" onclick={() => controls.nudgeFocus(FOCUS_FINE)}>▶</button>
				<button disabled={!!b} aria-label="Focus far, big step" onclick={() => controls.nudgeFocus(FOCUS_COARSE)}>▶▶</button>
			</div>
			<div class="nudge-legend"><span>Near</span><span>Far</span></div>
		{/if}
	</div>
{/if}

<style>
	.strip {
		display: grid;
		/* Phones: three tiles, then two wider ones. Wider screens: one row of five. */
		grid-template-columns: repeat(6, 1fr);
		gap: 8px;
		width: 100%;
		max-width: 44rem;
		margin: 0 auto;
		padding: 0 var(--pad);
	}
	.tile {
		grid-column: span 2;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		min-height: 72px;
		padding: 8px 12px;
		text-align: left;
		background: var(--surface);
		border-color: var(--border);
	}
	.tile.active {
		border-color: var(--accent);
	}
	.tile:disabled {
		opacity: 1;
	}
	.tile-label {
		font-size: 0.75rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-dim);
	}
	.tile-value {
		font-size: clamp(1rem, 4.6vw, 1.15rem);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.blocked .tile-value {
		color: var(--text-dim);
	}
	.tile-sub,
	.sheet-sub {
		font-size: 0.75rem;
		color: var(--text-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}
	.pending {
		color: var(--accent);
	}
	.no-echo {
		color: var(--warn);
	}

	.scrim {
		position: fixed;
		inset: 0;
		z-index: 24;
		min-height: 0;
		padding: 0;
		border: 0;
		border-radius: 0;
		background: rgb(0 0 0 / 0.35);
		cursor: default;
	}
	.sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 25;
		max-width: 34rem;
		max-height: 72dvh;
		margin: 0 auto;
		overflow-y: auto;
		overscroll-behavior: contain;
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 12px var(--pad) calc(var(--pad) + env(safe-area-inset-bottom, 0px));
		background: var(--surface);
		border-top: 2px solid var(--accent);
		border-radius: var(--radius) var(--radius) 0 0;
	}
	.sheet-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--gap);
	}
	.sheet-title {
		font-weight: 600;
	}
	.close {
		flex: none;
	}

	.stepper {
		display: grid;
		grid-template-columns: 64px 1fr 64px;
		align-items: center;
		gap: 8px;
	}
	.step {
		min-height: 56px;
		padding: 0;
		font-size: 1.1rem;
	}
	.step-value {
		text-align: center;
		font-size: 1.6rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.options {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
		gap: 6px;
	}
	.opt {
		padding: 0 6px;
		font-variant-numeric: tabular-nums;
	}
	.opt.on {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
		font-weight: 600;
	}
	.presets .opt {
		display: flex;
		flex-direction: column;
		justify-content: center;
		line-height: 1.15;
		min-height: 56px;
	}
	.presets small {
		font-size: 0.7rem;
		opacity: 0.8;
	}
	.pair {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 12px;
	}
	.field-label {
		font-size: 0.75rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-dim);
		margin-bottom: 4px;
	}
	.action {
		width: 100%;
	}
	.action.big {
		min-height: 64px;
		font-size: 1.1rem;
		font-weight: 600;
	}
	.action.sent {
		border-color: var(--ok);
	}
	.action.failed {
		border-color: var(--warn);
	}
	.nudge {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 8px;
	}
	.nudge button {
		min-height: 64px;
		padding: 0;
	}
	.nudge-legend {
		display: flex;
		justify-content: space-between;
		font-size: 0.75rem;
		color: var(--text-dim);
	}
	.note {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-dim);
	}
	.tile:nth-child(n + 5) {
		grid-column: span 3;
	}
	.tile-label {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.af {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
		min-height: 64px;
		background: var(--surface-2);
		border-color: var(--accent);
		color: var(--accent);
		font-size: 1.1rem;
		font-weight: 700;
		transition: background 0.15s;
	}
	.af:active:not(:disabled),
	.af.sent {
		background: var(--accent);
		color: var(--on-accent);
	}
	.af:disabled {
		border-color: var(--border);
		color: var(--text-dim);
	}
	.af-text {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		line-height: 1.2;
	}
	.af-sub {
		font-size: 0.75rem;
		font-weight: 400;
	}
	@media (min-width: 560px) {
		/* One row: autofocus, then the five tiles. */
		.af,
		.tile,
		.tile:nth-child(n + 5) {
			grid-column: auto;
		}
		.af {
			min-height: 72px;
			flex-direction: column;
			gap: 4px;
			font-size: 0.95rem;
		}
		.af-text {
			align-items: center;
		}
	}
</style>
