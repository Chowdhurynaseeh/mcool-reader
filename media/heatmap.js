'use strict';

const api = acquireVsCodeApi();
const el = id => document.getElementById(id);
const resolution = el('resolution');
const chromosome = el('chrom');
const start = el('start');
const end = el('end');
const display = el('display');
const mode = el('mode');
const scale = el('scale');
const palette = el('palette');
const zoom = el('zoom');
const canvas = el('map');
const stage = el('map-stage');
const contacts = document.createElement('canvas');
const tabs = [el('heatmap-tab'), el('metadata-tab')];
const numberFormat = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 8 });
const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 });
const unitFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const exactFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 });
const schemes = {
    red: [[255, 247, 235], [237, 115, 86], [132, 13, 41]],
    blue: [[245, 251, 255], [89, 157, 211], [8, 45, 112]]
};
const missingColor = [155, 155, 164];
const maxZoom = Number(zoom.max) / 100;
const maxBins = 512;
const countKeys = new Set(['nbins', 'nchroms', 'nnz', 'sum']);
const bpKeys = new Set(['bin-size', 'chromosome-length']);

let summary;
let tile;
let panel = 'heatmap';
let requestedSize;
let summaryRequest = 0;
let heatmapRequest = 0;
let pendingMetadata = true;
let settings = api.getState() || {};
let selection;
let drag;
let paintPending = false;
const viewport = { zoom: 1, x: 0, y: 0 };

function quantity(value) {
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
    return value;
}

function exact(value) {
    return value == null ? 'Unavailable' : exactFormat.format(quantity(value));
}

function compact(value) {
    return value == null ? 'Unavailable' : compactFormat.format(quantity(value));
}

function units(value, names) {
    let scaled = Number(value);
    let unit = 0;
    while (Math.abs(scaled) >= 1000 && unit < names.length - 1) {
        scaled /= 1000;
        ++unit;
    }
    return `${unitFormat.format(scaled)} ${names[unit]}`;
}

function bases(value) {
    return value == null ? 'Variable' : units(value, ['bp', 'kb', 'Mb', 'Gb', 'Tb']);
}

function bytes(value) {
    return value == null ? 'Unavailable' : units(value, ['B', 'KB', 'MB', 'GB', 'TB']);
}

function exactBases(value) {
    return value == null ? 'Variable' : `${exact(value)} bp`;
}

function element(tag, content, className) {
    const node = document.createElement(tag);
    if (content !== undefined) node.textContent = content;
    if (className) node.className = className;
    return node;
}

function status(id, message, kind = '') {
    const node = el(id);
    node.textContent = message;
    node.dataset.kind = kind;
    if (id === 'file-status') node.hidden = !message;
}

function selectPanel(name, focus = false) {
    panel = name;
    for (const tab of tabs) {
        const selected = tab.id === `${name}-tab`;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        el(tab.getAttribute('aria-controls')).hidden = !selected;
        if (selected && focus) tab.focus();
    }
    saveSettings();
    if (name === 'heatmap' && tile) schedulePaint();
}

function region() {
    return {
        chrom: chromosome.value,
        start: start.valueAsNumber,
        end: end.valueAsNumber,
        display: summary.size === null ? null : display.valueAsNumber,
        mode: mode.value
    };
}

function saveSettings() {
    if (!summary) return;
    settings = { ...region(), source: summary.size, scale: scale.value, palette: palette.value, panel };
    api.setState(settings);
}

function updateModes() {
    const custom = summary.size !== null && display.valueAsNumber !== summary.size;
    mode.options[1].disabled = !summary.weight || custom;
    if (mode.options[1].disabled) mode.value = 'raw';
    const note = !summary.weight ? 'This resolution has no default balancing weights.' : custom ? 'Balancing uses the stored bin size.' : '';
    el('mode-note').textContent = note;
    el('mode-note').hidden = !note;
}

function chromosomeLength() {
    return Number(chromosome.selectedOptions[0]?.dataset.length ?? 0);
}

function updateInterval() {
    const length = chromosomeLength();
    start.max = Math.max(0, length - 1);
    end.max = length;
    const note = el('interval-note');
    note.textContent = `0–${bases(length)} · end excluded`;
    note.title = `Chromosome length ${exactBases(length)}`;
}

function resetInterval() {
    const size = summary.size === null ? 1_000_000 : summary.size * 64;
    start.value = 0;
    end.value = Math.min(chromosomeLength(), size);
    updateInterval();
}

function setControls(data, previous) {
    resolution.replaceChildren();
    if (data.size === null) {
        resolution.add(new Option('Variable bins', ''));
    } else {
        for (const size of data.levels) {
            const option = new Option(bases(size), String(size));
            option.title = exactBases(size);
            resolution.add(option);
        }
        resolution.value = String(data.size);
    }
    resolution.disabled = resolution.options.length < 2;
    el('resolution-control').hidden = false;
    chromosome.replaceChildren();
    for (const [name, length] of Object.entries(data.chromosomes)) {
        const option = new Option(`${name} (${bases(length)})`, name);
        option.dataset.length = length;
        option.disabled = length <= 0;
        chromosome.add(option);
    }
    const matching = [...chromosome.options].find(option => option.value === previous.chrom && !option.disabled);
    const first = [...chromosome.options].find(option => !option.disabled);
    chromosome.value = matching?.value ?? first?.value ?? '';
    resetInterval();
    if (matching && Number.isSafeInteger(previous.start) && Number.isSafeInteger(previous.end) &&
        previous.start >= 0 && previous.start < previous.end && previous.end <= chromosomeLength()) {
        start.value = previous.start;
        end.value = previous.end;
        if (data.size !== null && previous.source !== data.size && binCount(previous.start, previous.end, data.size) > maxBins) {
            end.value = Math.min(chromosomeLength(), previous.start + data.size * 64);
        }
    }

    display.disabled = data.size === null;
    display.min = data.size ?? 1;
    display.step = data.size ?? 1;
    const remembered = data.size !== null && previous.source === data.size && Number.isSafeInteger(previous.display) &&
        previous.display >= data.size && previous.display % data.size === 0;
    display.value = data.size === null ? '' : remembered ? previous.display : data.size;
    display.placeholder = data.size === null ? 'Variable bins' : '';
    el('display-note').textContent = data.size === null ? 'Bin boundaries are stored in this file.' : `Use multiples of ${bases(data.size)}. Larger bins sum raw counts.`;
    el('display-note').title = data.size === null ? '' : `Use multiples of ${exactBases(data.size)}.`;
    palette.value = Object.hasOwn(schemes, previous.palette) ? previous.palette : 'red';
    scale.value = previous.scale === 'linear' ? 'linear' : 'log';
    mode.value = previous.mode === 'balanced' ? 'balanced' : 'raw';
    updateModes();
    el('draw').disabled = !first;
}

function overviewItem(list, label, value, detail) {
    const item = element('div');
    const description = element('dd', value);
    if (detail) description.title = detail;
    item.append(element('dt', label), description);
    list.append(item);
}

function attributeValue(key, value) {
    if (value !== null && typeof value === 'object') {
        const details = element('details');
        const entries = Array.isArray(value) ? value.map((entry, i) => [String(i + 1), entry]) : Object.entries(value);
        details.append(element('summary', `${exact(entries.length)} ${entries.length === 1 ? 'entry' : 'entries'}`));
        function showEntries() {
            if (!details.open) return;
            const list = element('dl', undefined, 'attribute-children');
            for (const [name, entry] of entries) {
                const description = element('dd');
                description.append(attributeValue(name, entry));
                list.append(element('dt', name), description);
            }
            details.append(list);
            details.removeEventListener('toggle', showEntries);
        }
        details.addEventListener('toggle', showEntries);
        return details;
    }
    const format = bpKeys.has(key) ? bases : countKeys.has(key) ? compact : null;
    const numeric = typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && /^-?\d+$/.test(value);
    if (format && numeric) {
        const label = format(value);
        const full = bpKeys.has(key) ? exactBases(value) : exact(value);
        const content = element('span', label, 'attribute-value');
        if (label !== full) content.append(element('span', `(${full})`, 'exact-value'));
        return content;
    }
    return element('span', value == null ? 'Unavailable' : String(value), 'attribute-value');
}

function renderChromosomes() {
    if (!summary) return;
    const list = el('chromosomes');
    const filter = el('chromosome-filter').value.trim().toLowerCase();
    const fragment = document.createDocumentFragment();
    const entries = Object.entries(summary.chromosomes);
    let shown = 0;
    for (const [name, length] of entries) {
        if (filter && !name.toLowerCase().includes(filter)) continue;
        const line = element('tr');
        const title = element('th', name);
        title.scope = 'row';
        line.append(title, element('td', bases(length)), element('td', exact(length)));
        fragment.append(line);
        ++shown;
    }
    list.replaceChildren(fragment);
    el('chromosome-empty').hidden = shown > 0;
    el('chromosome-count').textContent = `${filter ? `${exact(shown)} of ` : ''}${exact(entries.length)} ${entries.length === 1 ? 'chromosome' : 'chromosomes'}`;
}

function renderMetadata(data) {
    const overview = el('overview');
    overview.replaceChildren();
    overviewItem(overview, 'Genome assembly', data.assembly || 'Unavailable');
    overviewItem(overview, 'Stored resolution', bases(data.size), exactBases(data.size));
    overviewItem(overview, 'Bins', compact(data.bins), exact(data.bins));
    overviewItem(overview, 'Stored pixels', compact(data.pixels), exact(data.pixels));
    const total = data.attributes.sum;
    if (typeof total === 'number' || typeof total === 'string' && /^-?\d+$/.test(total)) {
        overviewItem(overview, 'Total contacts', compact(total), exact(total));
    }
    overviewItem(overview, 'Default weights', data.weight ? 'Present' : 'Absent');
    overviewItem(overview, 'File size', bytes(data.fileSize), `${exact(data.fileSize)} bytes`);
    renderChromosomes();
    const attributes = el('attributes');
    attributes.replaceChildren();
    const entries = Object.entries(data.attributes);
    for (const [key, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
        const row = element('tr');
        const name = element('th', key);
        const details = element('td');
        name.scope = 'row';
        details.append(attributeValue(key, value));
        row.append(name, details);
        attributes.append(row);
    }
    el('attributes-caption').textContent = data.size === null ? 'Variable-bin Cooler matrix' : `${bases(data.size)} Cooler matrix`;
    el('attribute-empty').hidden = entries.length > 0;
}

function setSummary(data) {
    const previous = settings;
    summary = data;
    setControls(data, previous);
    renderMetadata(data);
    const format = data.levels.length > 1 ? `${exact(data.levels.length)} stored resolutions` : data.size === null ? 'Variable bins' : 'Single resolution';
    const count = Object.keys(data.chromosomes).length;
    el('file-details').textContent = [format, `${exact(count)} ${count === 1 ? 'chromosome' : 'chromosomes'}`, bytes(data.fileSize)].join(' · ');
    el('file-details').hidden = false;
    el('workspace').hidden = false;
    selectPanel(previous.panel === 'metadata' ? 'metadata' : 'heatmap');
    if (chromosome.value) drawRegion();
    else status('plot-status', 'This file has no chromosomes with a positive length.');
}

function requestSummary(size) {
    requestedSize = size;
    pendingMetadata = true;
    ++heatmapRequest;
    resolution.disabled = true;
    el('draw').disabled = true;
    el('retry-metadata').hidden = true;
    status('file-status', 'Reading Cooler metadata…');
    api.postMessage({ type: 'summary', id: ++summaryRequest, size });
}

function binCount(left, right, binSize) {
    return Math.floor((right - 1) / binSize) - Math.floor(left / binSize) + 1;
}

function drawRegion() {
    if (pendingMetadata) return;
    const query = region();
    const id = ++heatmapRequest;
    tile = undefined;
    selection = undefined;
    el('figure').hidden = true;
    el('caption').hidden = true;
    el('save-png').disabled = true;
    syncZoomControls();
    if (!Number.isSafeInteger(query.start) || !Number.isSafeInteger(query.end) ||
        query.start < 0 || query.start >= query.end || query.end > chromosomeLength()) {
        status('plot-status', 'Choose a zero-based interval inside the chromosome. The end must be greater than the start.', 'error');
        return;
    }
    if (summary.size !== null && (!Number.isSafeInteger(query.display) || query.display < summary.size || query.display % summary.size !== 0)) {
        status('plot-status', `Display bin size must be a whole multiple of ${exactBases(summary.size)}.`, 'error');
        return;
    }
    if (query.display !== null) {
        const bins = binCount(query.start, query.end, query.display);
        if (bins > maxBins) {
            status('plot-status', `This region spans ${exact(bins)} bins. Shorten it or increase the display bin size to fit ${maxBins} bins.`, 'error');
            return;
        }
    }
    saveSettings();
    status('plot-status', 'Reading region…');
    api.postMessage({ type: 'heatmap', id, ...query });
}

function paintContacts() {
    const n = tile.starts.length;
    contacts.width = contacts.height = n;
    const ctx = contacts.getContext('2d');
    const image = ctx.createImageData(n, n);
    let max = 0;
    let hasFiniteValues = false;
    for (const row of tile.values) {
        for (const value of row) {
            if (value !== null) {
                max = Math.max(max, value);
                hasFiniteValues = true;
            }
        }
    }
    const transform = scale.value === 'log' ? Math.log1p : value => value;
    const high = transform(max);
    const [lowColor, midColor, highColor] = schemes[palette.value];
    for (let y = 0; y < n; ++y) {
        for (let x = 0; x < n; ++x) {
            const value = tile.values[y][x];
            const ratio = high && value !== null ? transform(Math.max(0, value)) / high : 0;
            const first = ratio < 0.55 ? lowColor : midColor;
            const second = ratio < 0.55 ? midColor : highColor;
            const mix = ratio < 0.55 ? ratio / 0.55 : (ratio - 0.55) / 0.45;
            const offset = (y * n + x) * 4;
            for (let channel = 0; channel < 3; ++channel) {
                image.data[offset + channel] = value === null ? missingColor[channel] : first[channel] + (second[channel] - first[channel]) * mix;
            }
            image.data[offset + 3] = 255;
        }
    }
    ctx.putImageData(image, 0, 0);
    el('legend-gradient').dataset.palette = palette.value;
    el('legend-max').textContent = numberFormat.format(max);
    el('legend-scale').textContent = scale.value === 'log' ? 'Logarithmic color scale' : 'Linear color scale';
    status('plot-status', !hasFiniteValues ? 'All values in this region are masked.' : max === 0 ? 'No positive contact values in this region.' : '');
    schedulePaint();
}

function setTile(data) {
    if (!data.starts.length) {
        status('plot-status', 'No stored bins overlap the requested interval.');
        return;
    }
    tile = data;
    selection = undefined;
    delete el('x-axis').dataset.key;
    delete el('y-axis').dataset.key;
    const size = data.size === null ? 'Variable bins' : `${bases(data.size)} bins`;
    const origin = data.size === data.source ? '' : ` · summed from ${bases(data.source)} bins`;
    const caption = el('caption');
    caption.textContent = `${data.chrom} · ${bases(data.starts[0])}–${bases(data.ends.at(-1))} · ${exact(data.starts.length)} × ${exact(data.starts.length)} · ${size}${origin}`;
    caption.title = `${data.chrom}:${exact(data.starts[0])}–${exact(data.ends.at(-1))} bp on both axes`;
    caption.hidden = false;
    el('figure').hidden = false;
    el('save-png').disabled = false;
    resetView();
    updateSelection();
    paintContacts();
}

function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

function syncZoomControls() {
    zoom.disabled = !tile;
    el('reset-view').disabled = !tile || viewport.zoom === 1;
    zoom.value = Math.round(viewport.zoom * 100);
    el('zoom-level').textContent = `${zoom.value}%`;
    stage.dataset.zoomed = String(viewport.zoom > 1);
}

function moveTo(x, y) {
    const limit = 1 - 1 / viewport.zoom;
    viewport.x = clamp(x, 0, limit);
    viewport.y = clamp(y, 0, limit);
}

function changeZoom(value, x = 0.5, y = 0.5) {
    if (!tile) return;
    const next = clamp(Math.round(value * 10) / 10, 1, maxZoom);
    if (next === viewport.zoom) return;
    const shift = 1 / viewport.zoom - 1 / next;
    viewport.zoom = next;
    moveTo(viewport.x + shift * x, viewport.y + shift * y);
    syncZoomControls();
    schedulePaint();
}

function resetView() {
    viewport.zoom = 1;
    moveTo(0, 0);
    syncZoomControls();
    schedulePaint();
}

function axisCoordinate(fraction) {
    const n = tile.starts.length;
    const index = clamp(fraction * n, 0, n);
    if (index === n) return tile.ends[n - 1];
    const bin = Math.floor(index);
    return Math.round(tile.starts[bin] + (tile.ends[bin] - tile.starts[bin]) * (index - bin));
}

function renderAxis(id, offset, width) {
    const axis = el(id);
    const count = width < 280 ? 3 : width < 450 ? 4 : 5;
    const key = `${offset},${viewport.zoom},${count}`;
    if (axis.dataset.key === key) return;
    axis.dataset.key = key;
    const ticks = document.createDocumentFragment();
    const coordinates = Array.from({ length: count }, (_, i) => axisCoordinate(offset + i / (count - 1) / viewport.zoom));
    const labels = coordinates.map(bases);
    const needsPrecision = new Set(labels).size < new Set(coordinates).size;
    for (let i = 0; i < count; ++i) {
        const position = i / (count - 1);
        const label = needsPrecision ? exactBases(coordinates[i]) : labels[i];
        const tick = element('span', label, i === 0 ? 'first' : i === count - 1 ? 'last' : '');
        tick.style.setProperty('--tick-position', `${position * 100}%`);
        ticks.append(tick);
    }
    axis.replaceChildren(ticks);
}

function schedulePaint() {
    if (paintPending) return;
    paintPending = true;
    requestAnimationFrame(() => {
        paintPending = false;
        if (tile && panel === 'heatmap') paintView();
    });
}

function paintView() {
    const width = canvas.clientWidth;
    if (!width) return;
    const pixels = Math.max(1, Math.round(width * window.devicePixelRatio));
    if (canvas.width !== pixels || canvas.height !== pixels) canvas.width = canvas.height = pixels;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const n = tile.starts.length;
    const viewSize = n / viewport.zoom;
    ctx.drawImage(contacts, viewport.x * n, viewport.y * n, viewSize, viewSize, 0, 0, pixels, pixels);
    renderAxis('x-axis', viewport.x, width);
    renderAxis('y-axis', viewport.y, width);
    if (!selection) return;
    const position = (bin, offset) => Math.round(((bin + 0.5) / n - offset) * viewport.zoom * pixels) + 0.5;
    const x = position(selection.x, viewport.x);
    const y = position(selection.y, viewport.y);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, pixels);
    ctx.moveTo(0, y);
    ctx.lineTo(pixels, y);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, .6)';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, .9)';
    ctx.stroke();
}

function canvasPoint(event) {
    const box = canvas.getBoundingClientRect();
    return { x: clamp((event.clientX - box.left) / box.width, 0, 1), y: clamp((event.clientY - box.top) / box.height, 0, 1) };
}

function inspectPoint(point) {
    const n = tile.starts.length;
    const bin = (position, offset) => Math.min(n - 1, Math.floor((position / viewport.zoom + offset) * n));
    const x = bin(point.x, viewport.x);
    const y = bin(point.y, viewport.y);
    if (selection?.x === x && selection.y === y) return;
    selection = { x, y };
    updateSelection();
    schedulePaint();
}

function updateSelection(announce = false) {
    el('pixel').hidden = !selection;
    el('pixel-empty').hidden = Boolean(selection);
    if (!selection) {
        el('pixel-announcement').textContent = '';
        return;
    }
    const value = tile.values[selection.y][selection.x];
    for (const axis of ['x', 'y']) {
        const i = selection[axis];
        const node = el(`pixel-${axis}`);
        node.textContent = `${tile.chrom}:${bases(tile.starts[i])}–${bases(tile.ends[i])}`;
        node.title = `${tile.chrom}:${exact(tile.starts[i])}–${exact(tile.ends[i])} bp`;
    }
    el('pixel-measure').textContent = tile.mode === 'raw' ? 'Contact count' : 'Balanced value';
    el('pixel-value').textContent = value === null ? 'Missing' : numberFormat.format(value);
    el('pixel-value').title = value === null ? '' : String(value);
    if (announce) {
        el('pixel-announcement').textContent = `X ${el('pixel-x').title}, Y ${el('pixel-y').title}, ${el('pixel-measure').textContent} ${el('pixel-value').textContent}`;
    }
}

function exportPng() {
    if (!tile) return;
    const image = document.createElement('canvas');
    const size = contacts.width * Math.ceil(512 / contacts.width);
    image.width = image.height = size;
    try {
        const ctx = image.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(contacts, 0, 0, size, size);
        const binSize = tile.size === null ? 'variable' : `${tile.size}bp`;
        const name = `${tile.chrom}_${tile.starts[0]}-${tile.ends.at(-1)}_${binSize}_${tile.mode}`;
        api.postMessage({ type: 'savePng', region: name, dataUrl: image.toDataURL('image/png') });
    } catch {
        status('plot-status', 'Could not encode this heatmap as PNG.', 'error');
    }
}

for (const tab of tabs) {
    tab.addEventListener('click', () => selectPanel(tab.id.split('-')[0]));
    tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'heatmap' : event.key === 'End' ? 'metadata' : panel === 'heatmap' ? 'metadata' : 'heatmap';
        selectPanel(next, true);
    });
}

el('region').addEventListener('submit', event => {
    event.preventDefault();
    drawRegion();
});
resolution.addEventListener('change', () => {
    const size = Number(resolution.value);
    saveSettings();
    requestSummary(size);
});
chromosome.addEventListener('change', () => { resetInterval(); drawRegion(); });
mode.addEventListener('change', drawRegion);
display.addEventListener('input', updateModes);
for (const control of [scale, palette]) {
    control.addEventListener('change', () => {
        saveSettings();
        if (tile) paintContacts();
    });
}
zoom.addEventListener('input', () => changeZoom(zoom.valueAsNumber / 100));
el('reset-view').addEventListener('click', resetView);
el('save-png').addEventListener('click', exportPng);
el('retry-metadata').addEventListener('click', () => requestSummary(requestedSize));
el('chromosome-filter').addEventListener('input', renderChromosomes);

canvas.addEventListener('wheel', event => {
    if (!tile || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    const point = canvasPoint(event);
    changeZoom(viewport.zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2), point.x, point.y);
    inspectPoint(point);
}, { passive: false });
canvas.addEventListener('pointerdown', event => {
    if (!tile || viewport.zoom <= 1 || event.button !== 0 || drag) return;
    canvas.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, point: canvasPoint(event), x: viewport.x, y: viewport.y };
    stage.dataset.dragging = 'true';
});
canvas.addEventListener('pointermove', event => {
    if (!tile) return;
    const point = canvasPoint(event);
    if (drag && drag.id === event.pointerId) {
        moveTo(drag.x - (point.x - drag.point.x) / viewport.zoom, drag.y - (point.y - drag.point.y) / viewport.zoom);
        schedulePaint();
    }
    inspectPoint(point);
});
canvas.addEventListener('lostpointercapture', event => {
    if (!drag || drag.id !== event.pointerId) return;
    drag = undefined;
    stage.dataset.dragging = 'false';
});
canvas.addEventListener('pointerleave', () => {
    if (drag || document.activeElement === canvas) return;
    selection = undefined;
    updateSelection();
    schedulePaint();
});
canvas.addEventListener('focus', () => {
    if (tile && !selection) inspectPoint({ x: 0.5, y: 0.5 });
    updateSelection(true);
});
canvas.addEventListener('keydown', event => {
    if (!tile || event.altKey || event.ctrlKey || event.metaKey) return;
    if (['+', '=', '-', 'Home'].includes(event.key)) {
        event.preventDefault();
        if (event.key === 'Home') resetView();
        else changeZoom(viewport.zoom * (event.key === '-' ? 1 / 1.3 : 1.3));
        return;
    }
    const steps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!Object.hasOwn(steps, event.key)) return;
    event.preventDefault();
    if (!selection) inspectPoint({ x: 0.5, y: 0.5 });
    const [dx, dy] = steps[event.key];
    const n = tile.starts.length;
    selection = { x: clamp(selection.x + dx, 0, n - 1), y: clamp(selection.y + dy, 0, n - 1) };
    const span = 1 / viewport.zoom;
    const follow = (index, offset) => {
        const position = (index + 0.5) / n;
        return position < offset || position > offset + span ? position - span / 2 : offset;
    };
    moveTo(follow(selection.x, viewport.x), follow(selection.y, viewport.y));
    updateSelection(true);
    schedulePaint();
});
new ResizeObserver(schedulePaint).observe(stage);

window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'summary') {
        const initial = message.id === undefined && summaryRequest === 0;
        if (!initial && message.id !== summaryRequest) return;
        pendingMetadata = false;
        if (typeof message.title === 'string') el('file-name').textContent = message.title;
        if (message.error) {
            status('file-status', message.error, 'error');
            el('retry-metadata').hidden = false;
            if (summary) {
                resolution.value = String(summary.size);
                resolution.disabled = summary.levels.length < 2;
                el('draw').disabled = !chromosome.value;
                if (!tile && chromosome.value && el('plot-status').textContent === 'Reading region…') drawRegion();
            }
        } else {
            status('file-status', '');
            setSummary(message.summary);
        }
    } else if (message.type === 'heatmap' && message.id === heatmapRequest) {
        if (message.error) status('plot-status', message.error, 'error');
        else setTile(message.tile);
    }
});

if (Number.isSafeInteger(settings.source)) api.postMessage({ type: 'ready', size: settings.source });
else api.postMessage({ type: 'ready' });
