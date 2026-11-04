declare const brand: unique symbol;

/** Nominal typing helper: `Brand<string, 'AccountId'>` is not assignable from plain `string`. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };
