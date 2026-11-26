// A tiny comparison such as "== 1", "> 90" or "<= 0.5", used to turn a number into up / warning / down. No expressions beyond this.
export interface Condition { op: '==' | '!=' | '<' | '<=' | '>' | '>='; n: number }

/** Pure: "> 90" to a condition, or null when the text is not one. */
export function parseCondition(text: string | undefined): Condition | null {
  const m = /^\s*(==|!=|<=|>=|<|>)\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$/i.exec(String(text ?? ''));
  return m ? { op: m[1] as Condition['op'], n: Number(m[2]) } : null;
}

export function holds(c: Condition, v: number): boolean {
  switch (c.op) {
    case '==': return v === c.n;
    case '!=': return v !== c.n;
    case '<': return v < c.n;
    case '<=': return v <= c.n;
    case '>': return v > c.n;
    case '>=': return v >= c.n;
  }
}
