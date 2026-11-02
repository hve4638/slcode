export declare const COLLECT: unique symbol;
export declare const slcode: {
    vars: Readonly<{
        [x: string]: unknown;
    }>;
    on(event: unknown, a: unknown, b?: unknown): void;
    run(): void;
    command(def: unknown): void;
};
