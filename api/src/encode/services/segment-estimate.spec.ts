import type { EncodeConfigDto } from '../dto/encode-config.dto';
import { estimateSegments } from './segment-estimate';

const config = (over: Partial<EncodeConfigDto> = {}) =>
    ({
        videoRenditions: [{}, {}, {}],
        audioGroups: [{}],
        ...over,
    }) as unknown as EncodeConfigDto;

describe('estimateSegments', () => {
    it('counts every stream over the whole source', () => {
        // 4 streams × ceil(125 / 6) = 4 × 21
        expect(estimateSegments(config(), 125, 6)).toBe(84);
    });

    it('counts only what a trim keeps, not the parts cut out', () => {
        const trimmed = config({
            trimSegments: [
                { inSec: 0, outSec: 20 },
                { inSec: 40, outSec: 70 },
            ],
        } as Partial<EncodeConfigDto>);
        // 50 s kept of 125: 4 × ceil(50 / 6) = 4 × 9
        expect(estimateSegments(trimmed, 125, 6)).toBe(36);
    });

    it('has no estimate without streams or a length', () => {
        expect(estimateSegments(config({ videoRenditions: [], audioGroups: [] }), 125, 6)).toBeUndefined();
        expect(estimateSegments(config(), 0, 6)).toBeUndefined();
    });
});
