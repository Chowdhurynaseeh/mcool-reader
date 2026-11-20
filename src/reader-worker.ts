import { stat } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import type { Dataset, Entity, File, Group } from 'h5wasm/node' with { 'resolution-mode': 'import' };
import type { HeatmapTile, ReaderRequest, ReaderResponse, Region, Summary } from './reader';

const MAX_TILE_BINS = 512;
const OFFSET_BATCH = 25_000;
const PIXEL_BATCH = 250_000;

type NumericValues = ArrayLike<number | bigint>;
type AttributeMap = Group['attrs'];
let hdf5Module: Awaited<ReturnType<typeof loadHdf5>>['Module'];

function isGroup(value: Entity | null): value is Group {
    return value !== null && 'type' in value && value.type === 'Group';
}

function isDataset(value: Entity | null): value is Dataset {
    return value !== null && 'type' in value && value.type === 'Dataset';
}

function integer(value: unknown): number | null {
    const number = typeof value === 'bigint' ? Number(value) : value;
    return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function column(group: Group, name: string): Dataset {
    const dataset = group.get(name);
    if (!isDataset(dataset) || dataset.shape?.length !== 1 || integer(dataset.shape[0]) === null) {
        throw new Error(`This Cooler collection has a missing or invalid ${name} column.`);
    }
    return dataset;
}

function checkedRead<T>(dataset: Dataset, read: () => T): T {
    // The high-level h5wasm reader otherwise ignores HDF5's read error status.
    hdf5Module.activate_throwing_error_handler();
    try {
        return read();
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/filter|plugin/i.test(detail)) {
            throw new Error(`Could not decompress ${dataset.path}. Use a Cooler file with standard HDF5 compression such as gzip.`);
        }
        throw new Error(`Could not read data from ${dataset.path}.`);
    } finally {
        hdf5Module.deactivate_throwing_error_handler();
    }
}

function slice(dataset: Dataset, first: number, stop: number): NumericValues {
    if (first === stop) return [];
    if (first < 0 || stop < first || stop > dataset.shape![0]) {
        throw new Error(`The Cooler index is out of bounds in ${dataset.path}.`);
    }
    const values = checkedRead(dataset, () => dataset.slice([[first, stop]]));
    if (!ArrayBuffer.isView(values) || values instanceof DataView || values.length !== stop - first) {
        throw new Error(`Could not read numeric data from ${dataset.path}.`);
    }
    return values;
}

function index(value: unknown): number {
    const result = integer(value);
    if (result === null) throw new Error('The Cooler collection contains an invalid bin or pixel index.');
    return result;
}

function attribute(attributes: AttributeMap, name: string): unknown {
    return Object.hasOwn(attributes, name) ? attributes[name].value : null;
}

function metadataValue(value: unknown): unknown {
    if (typeof value === 'bigint') {
        const number = Number(value);
        return Number.isSafeInteger(number) ? number : String(value);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) return value.map(metadataValue);
    if (ArrayBuffer.isView(value) && 'length' in value) {
        return Array.from(value as unknown as NumericValues, metadataValue);
    }
    return value;
}

function metadata(attributes: AttributeMap): Record<string, unknown> {
    return Object.fromEntries(Object.keys(attributes).map(name => {
        try {
            const value = metadataValue(attribute(attributes, name));
            if (name === 'metadata' && typeof value === 'string') {
                try {
                    return [name, JSON.parse(value)];
                } catch {
                    return [name, value];
                }
            }
            return [name, value];
        } catch {
            return [name, 'Unavailable HDF5 attribute'];
        }
    }));
}

function selectCollection(file: File, selected?: number | null) {
    const resolutions = file.get('resolutions');
    let group: Group = file;
    let levels: number[] = [];
    let resolution: number | undefined;
    if (isGroup(resolutions)) {
        levels = resolutions.keys()
            .filter(key => /^[1-9]\d*$/.test(key))
            .map(Number)
            .filter(size => Number.isSafeInteger(size) && isGroup(resolutions.get(String(size))))
            .sort((a, b) => a - b);
        resolution = selected ?? levels.at(-1);
        if (resolution === undefined || !levels.includes(resolution)) {
            throw new Error('The requested resolution is absent from the /resolutions group.');
        }
        group = resolutions.get(String(resolution)) as Group;
    }

    const attributes = group.attrs;
    const format = attribute(attributes, 'format');
    if (typeof format === 'string' && format.toLowerCase() !== 'hdf5::cooler') {
        throw new Error('Expected a .cool file or a .mcool file with /resolutions/<bin size> groups.');
    }
    const variable = attribute(attributes, 'bin-type') === 'variable';
    const size = variable ? null : integer(attribute(attributes, 'bin-size'));
    if (resolution !== undefined && size !== resolution) {
        throw new Error('This multi-resolution file must have fixed bins matching its resolution groups.');
    }
    if (size === 0 || (size === null && !variable)) {
        throw new Error('The Cooler collection has an invalid bin size.');
    }
    if (levels.length === 0 && size !== null) levels = [size];
    if (selected !== undefined && selected !== size) throw new Error('The requested resolution is absent.');

    return { group, attributes, levels, size };
}

function readChromosomes(group: Group): [string, number][] {
    const namesDataset = column(group, 'chroms/name');
    const lengthDataset = column(group, 'chroms/length');
    const names = checkedRead(namesDataset, () => namesDataset.value);
    const lengths = slice(lengthDataset, 0, lengthDataset.shape![0]);
    if (!Array.isArray(names) || names.length !== lengths.length) {
        throw new Error('The Cooler collection has invalid chromosome names or lengths.');
    }
    const seen = new Set<string>();
    return Array.from(names, (name, chromosome) => {
        const length = index(lengths[chromosome]);
        if (typeof name !== 'string' || !name || seen.has(name)) {
            throw new Error('The Cooler collection has invalid or duplicate chromosome names.');
        }
        seen.add(name);
        return [name, length];
    });
}

function readSummary(collection: ReturnType<typeof selectCollection>, fileSize: number): Summary {
    const { group, attributes, levels, size } = collection;
    const assembly = attribute(attributes, 'genome-assembly') ?? attribute(attributes, 'assembly');
    return {
        levels,
        size,
        assembly: typeof assembly === 'string' ? assembly : null,
        bins: column(group, 'bins/start').shape![0],
        pixels: column(group, 'pixels/count').shape![0],
        weight: isDataset(group.get('bins/weight')),
        chromosomes: Object.fromEntries(readChromosomes(group)),
        attributes: metadata(attributes),
        fileSize
    };
}

function firstMatching(dataset: Dataset, first: number, stop: number, predicate: (value: number) => boolean): number {
    while (first < stop) {
        const middle = first + Math.floor((stop - first) / 2);
        if (predicate(index(slice(dataset, middle, middle + 1)[0]))) stop = middle;
        else first = middle + 1;
    }
    return first;
}

function findBins(group: Group, region: Region, size: number | null, chromosome: number, length: number) {
    const { start, end, display } = region;
    const chromosomeOffsets = slice(column(group, 'indexes/chrom_offset'), chromosome, chromosome + 2);
    const firstChromosomeBin = index(chromosomeOffsets[0]);
    const stopChromosomeBin = index(chromosomeOffsets[1]);
    const binStarts = column(group, 'bins/start');
    const binEnds = column(group, 'bins/end');
    const chromBinCount = stopChromosomeBin - firstChromosomeBin;
    if (chromBinCount < 0 || stopChromosomeBin > binStarts.shape![0] || stopChromosomeBin > binEnds.shape![0]) {
        throw new Error('The Cooler chromosome index is inconsistent with its bin coordinates.');
    }

    if (size !== null && display !== null) {
        const startDisplayBin = Math.floor(start / display);
        const stopDisplayBin = Math.floor((end - 1) / display) + 1;
        const count = stopDisplayBin - startDisplayBin;
        assertTileSize(count);
        const factor = display / size;
        const first = firstChromosomeBin + startDisplayBin * factor;
        const stop = firstChromosomeBin + Math.min(chromBinCount, stopDisplayBin * factor);
        if (first >= stop) throw new Error('This interval has no stored bins.');
        if (factor === 1) {
            return { first, stop, factor, starts: Array.from(slice(binStarts, first, stop), index),
                ends: Array.from(slice(binEnds, first, stop), index) };
        }
        const starts = Array.from({ length: count }, (_, bin) => (startDisplayBin + bin) * display);
        const ends = starts.map(bin => Math.min(length, bin + display));
        return { first, stop, factor, starts, ends };
    }

    const first = firstMatching(binEnds, firstChromosomeBin, stopChromosomeBin, value => value > start);
    const stop = firstMatching(binStarts, first, stopChromosomeBin, value => value >= end);
    assertTileSize(stop - first);
    if (first === stop) throw new Error('This interval has no stored bins.');
    return { first, stop, factor: 1, starts: Array.from(slice(binStarts, first, stop), index),
        ends: Array.from(slice(binEnds, first, stop), index) };
}

function assertTileSize(count: number) {
    if (count > MAX_TILE_BINS) {
        throw new Error(`This interval spans ${count.toLocaleString('en-US')} bins. Choose a shorter interval or a coarser bin size (limit ${MAX_TILE_BINS}).`);
    }
}

function sumPixels(group: Group, { first, stop, factor, starts }: ReturnType<typeof findBins>): Float64Array[] {
    const offsets = column(group, 'indexes/bin1_offset');
    const columns = column(group, 'pixels/bin2_id');
    const counts = column(group, 'pixels/count');
    const values = starts.map(() => new Float64Array(starts.length));

    // The CSR offsets identify which source row owns each pixel. Batching the
    // offsets and pixels also bounds memory when aggregating very fine bins.
    for (let firstRow = first; firstRow < stop; firstRow += OFFSET_BATCH) {
        const stopRow = Math.min(firstRow + OFFSET_BATCH, stop);
        const rowOffsets = Array.from(slice(offsets, firstRow, stopRow + 1), index);
        const lastPixel = rowOffsets[rowOffsets.length - 1];
        if (rowOffsets.some((offset, row) => row > 0 && offset < rowOffsets[row - 1]) ||
            lastPixel > counts.shape![0] || lastPixel > columns.shape![0]) {
            throw new Error('The Cooler pixel index is inconsistent with its contact matrix.');
        }
        let row = 0;
        for (let firstPixel = rowOffsets[0]; firstPixel < lastPixel; firstPixel += PIXEL_BATCH) {
            const stopPixel = Math.min(firstPixel + PIXEL_BATCH, lastPixel);
            const pixelColumns = slice(columns, firstPixel, stopPixel);
            const pixelCounts = slice(counts, firstPixel, stopPixel);
            for (let pixel = 0; pixel < pixelColumns.length; pixel++) {
                const col = Number(pixelColumns[pixel]);
                if (col < first || col >= stop) continue;
                while (firstPixel + pixel >= rowOffsets[row + 1]) row++;
                const targetRow = Math.floor((firstRow + row - first) / factor);
                const targetCol = Math.floor((index(col) - first) / factor);
                values[targetRow][targetCol] += Number(pixelCounts[pixel]);
            }
        }
    }
    return values;
}

function readHeatmap(collection: ReturnType<typeof selectCollection>, region: Region): HeatmapTile {
    const { group, size, attributes } = collection;
    const { chrom, start, end, mode, display } = region;
    const chromosomes = readChromosomes(group);
    const chromosome = chromosomes.findIndex(([name]) => name === chrom);
    const length = chromosomes[chromosome]?.[1];
    if (length === undefined || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end <= start || end > length) {
        throw new Error('Choose an interval inside the selected chromosome.');
    }
    if (mode !== 'raw' && mode !== 'balanced') throw new Error('Unknown heatmap values.');
    if (size === null ? display !== null :
        display === null || !Number.isSafeInteger(display) || display < size || display % size !== 0) {
        throw new Error(size === null ? 'Display bin size is unavailable for variable bins.' :
            `Display bins must be whole multiples of ${size.toLocaleString('en-US')} bp.`);
    }
    if (mode === 'balanced' && display !== size) {
        throw new Error('Custom display binning requires raw contact counts.');
    }
    if (mode === 'balanced' && !isDataset(group.get('bins/weight'))) {
        throw new Error('This resolution has no default balancing weights.');
    }

    const bounds = findBins(group, region, size, chromosome, length);
    const { first, stop, starts, ends } = bounds;
    const weights = mode === 'balanced' ? slice(column(group, 'bins/weight'), first, stop) : null;
    const values = sumPixels(group, bounds);
    const symmetric = attribute(attributes, 'storage-mode') !== 'square';
    return {
        chrom, mode, size: display, source: size, starts, ends,
        values: values.map((row, i) => Array.from(row, (pixel, j) => {
            const count = symmetric && j < i ? values[j][i] : pixel;
            const value = weights ? count * Number(weights[i]) * Number(weights[j]) : count;
            return Number.isFinite(value) ? value : null;
        }))
    };
}

async function loadHdf5() {
    // Some Electron versions expose navigator to the worker. The Node build
    // of h5wasm needs to initialize its filesystem in a Node environment.
    const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    if (navigator?.configurable) Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
    try {
        const hdf5 = await import('h5wasm/node');
        await hdf5.ready;
        return hdf5;
    } finally {
        if (navigator?.configurable) Object.defineProperty(globalThis, 'navigator', navigator);
    }
}

async function read(fileName: string, request: ReaderRequest): Promise<Summary | HeatmapTile> {
    const info = await stat(fileName);
    if (!info.isFile()) throw new Error('Choose a local Cooler file.');
    const hdf5 = await loadHdf5();
    hdf5Module = hdf5.Module;
    const file = new hdf5.File(fileName, 'r');
    if (file.file_id < 0) throw new Error('Could not open this file as HDF5.');
    try {
        const collection = selectCollection(file, request.size);
        return request.type === 'summary' ? readSummary(collection, info.size) : readHeatmap(collection, request.region);
    } finally {
        file.close();
    }
}

async function run() {
    const { file, request } = workerData as { file: string; request: ReaderRequest };
    let response: ReaderResponse;
    try {
        response = { result: await read(file, request) };
    } catch (error) {
        response = { error: error instanceof Error ? error.message : String(error) };
    }
    parentPort!.postMessage(response);
}

void run();
