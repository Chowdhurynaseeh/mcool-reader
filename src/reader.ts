import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

export interface Summary {
    levels: number[];
    size: number | null;
    assembly: string | null;
    bins: number;
    pixels: number;
    weight: boolean;
    chromosomes: Record<string, number>;
    attributes: Record<string, unknown>;
    fileSize: number;
}

export interface Region {
    chrom: string;
    start: number;
    end: number;
    mode: 'raw' | 'balanced';
    display: number | null;
}

export interface HeatmapTile {
    chrom: string;
    mode: Region['mode'];
    size: number | null;
    source: number | null;
    starts: number[];
    ends: number[];
    values: (number | null)[][];
}

export interface SummaryRequest {
    type: 'summary';
    size?: number;
}

export interface HeatmapRequest {
    type: 'heatmap';
    size: number | null;
    region: Region;
}

export type ReaderRequest = SummaryRequest | HeatmapRequest;
export type ReaderResponse = { result: Summary | HeatmapTile } | { error: string };

export function readCooler(file: string, request: SummaryRequest, signal: AbortSignal): Promise<Summary>;
export function readCooler(file: string, request: HeatmapRequest, signal: AbortSignal): Promise<HeatmapTile>;
export async function readCooler(file: string, request: ReaderRequest, signal: AbortSignal): Promise<Summary | HeatmapTile> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const worker = new Worker(join(__dirname, 'reader-worker.js'), { workerData: { file, request } });
        const abort = () => {
            reject(signal.reason);
            void worker.terminate();
        };
        signal.addEventListener('abort', abort, { once: true });
        worker.once('message', (response: ReaderResponse) => {
            signal.removeEventListener('abort', abort);
            if ('error' in response) reject(new Error(response.error));
            else resolve(response.result);
        });
        worker.once('error', reject);
        worker.once('exit', () => {
            signal.removeEventListener('abort', abort);
            reject(new Error('The Cooler reader exited before returning data.'));
        });
    });
}
