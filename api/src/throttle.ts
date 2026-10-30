import { SkipThrottle } from '@nestjs/throttler';

/** The API's request limits, by name. */
export const THROTTLERS = [
    { name: 'short', ttl: 1000, limit: 100 },
    { name: 'medium', ttl: 60000, limit: 1000 },
];

/**
 * Exempts a controller or route from every request limit.
 *
 * A bare `SkipThrottle()` exempts only a limit named `default`, which this API
 * does not have, so it exempted nothing: the trim timeline asks for hundreds of
 * storyboard frames at once, and those past the hundredth in a second were
 * refused and never drawn.
 */
export const SkipAllThrottles = (): MethodDecorator & ClassDecorator =>
    SkipThrottle(
        Object.fromEntries(
            THROTTLERS.map((throttler) => [throttler.name, true])
        )
    );
