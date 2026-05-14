import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';

@Injectable()
export class WaveformService {
    private readonly logger = new Logger(WaveformService.name);

    async generateWaveform(
        filePath: string,
        numPeaks: number = 1000
    ): Promise<number[]> {
        let resolvedPath = filePath;
        this.logger.log(`generateWaveform called with filePath: ${filePath}`);

        // If filePath doesn't exist, try to find the uploaded file in the directory
        if (!existsSync(resolvedPath)) {
            const dir = dirname(resolvedPath);
            this.logger.log(`File not found at ${resolvedPath}, checking directory: ${dir}`);

            if (existsSync(dir)) {
                try {
                    const allFiles = readdirSync(dir);
                    this.logger.log(`Files in directory: ${allFiles.join(', ')}`);

                    const files = allFiles.filter(
                        (f) => !f.startsWith('.') && !f.endsWith('.info'),
                    );
                    this.logger.log(`Filtered files: ${files.join(', ')}`);

                    if (files.length > 0) {
                        resolvedPath = join(dir, files[0]);
                        this.logger.log(
                            `Using first file in directory: ${resolvedPath}`,
                        );
                    } else {
                        this.logger.warn(`No usable files found in ${dir}`);
                    }
                } catch (err) {
                    this.logger.error(`Failed to list directory ${dir}: ${err}`);
                }
            } else {
                this.logger.warn(`Directory does not exist: ${dir}`);
            }
        }

        if (!existsSync(resolvedPath)) {
            throw new Error(`Source file does not exist: ${resolvedPath}`);
        }

        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let errOutput = '';

            const ffmpeg = spawn('ffmpeg', [
                '-i',
                filePath,
                '-af',
                'aresample=8000,aformat=sample_fmts=s16:channel_layouts=mono',
                '-f',
                's16le',
                'pipe:1',
            ]);

            ffmpeg.stdout.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
            });

            ffmpeg.stderr.on('data', (data: Buffer) => {
                errOutput += data.toString();
            });

            ffmpeg.on('error', (err) => {
                this.logger.error(`FFmpeg spawn error: ${err.message}`);
                reject(err);
            });

            ffmpeg.on('close', (code) => {
                if (code !== 0) {
                    this.logger.error(
                        `FFmpeg exited with code ${code}: ${errOutput}`
                    );
                    reject(new Error(`FFmpeg exited with code ${code}`));
                    return;
                }

                try {
                    const buffer = Buffer.concat(chunks);
                    const samples = new Int16Array(
                        buffer.buffer,
                        buffer.byteOffset,
                        buffer.length / 2
                    );
                    const peaks = this.computePeaks(samples, numPeaks);
                    resolve(peaks);
                } catch (err) {
                    this.logger.error(`Error computing peaks: ${err}`);
                    reject(err);
                }
            });
        });
    }

    private computePeaks(samples: Int16Array, numPeaks: number): number[] {
        const peaks: number[] = [];
        const samplesPerPeak = Math.floor(samples.length / numPeaks);

        if (samplesPerPeak === 0) {
            // File is very short, return one sample per peak
            for (
                let i = 0;
                i < samples.length && peaks.length < numPeaks;
                i++
            ) {
                peaks.push(Math.abs(samples[i]) / 32768);
            }
            return peaks;
        }

        for (let i = 0; i < numPeaks; i++) {
            let max = 0;
            const startIdx = i * samplesPerPeak;
            const endIdx = Math.min(startIdx + samplesPerPeak, samples.length);

            for (let j = startIdx; j < endIdx; j++) {
                const normalized = Math.abs(samples[j]) / 32768;
                max = Math.max(max, normalized);
            }

            peaks.push(Math.min(max, 1));
        }

        return peaks;
    }
}
