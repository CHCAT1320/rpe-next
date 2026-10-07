export interface Session { chart: string; [key: string]: unknown }
export class Real { chart = 'x'; }
export function take(fn: () => Session): void { void fn; }
export const real = new Real();
take(() => real);
