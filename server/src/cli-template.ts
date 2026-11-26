// A tiny logic-light template engine for the files homedash-config renders (nginx, Loki, Alloy, Prometheus, ...).
//   {{path.to.value}}             value (HTML is NOT escaped: these are config files); missing = empty string
//   {{#if path}}...{{/if}}        block shown when the value is truthy (non-empty list/string, true, non-zero)
//   {{#if path}}..{{else}}..{{/if}}
//   {{#unless path}}...{{/unless}}
//   {{#each list}}...{{/each}}    inside: {{.}} the item, {{.field}} a field of it, {{@index}}, {{@first}}, {{@last}}
// Blocks nest. Lines that contain only a block tag are removed together with their newline, so templates stay readable.

type Ctx = { root: unknown; item?: unknown; index?: number; length?: number };

function lookup(path: string, ctx: Ctx): unknown {
  const p = path.trim();
  if (p === '@index') return ctx.index;
  if (p === '@first') return ctx.index === 0;
  if (p === '@last') return ctx.index !== undefined && ctx.index === (ctx.length ?? 0) - 1;
  let cur: unknown;
  let rest: string;
  if (p === '.') return ctx.item;
  if (p.startsWith('.')) { cur = ctx.item; rest = p.slice(1); } else { cur = ctx.root; rest = p; }
  for (const part of rest.split('.').filter(Boolean)) {
    if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[part]; else return undefined;
  }
  return cur;
}

const truthy = (v: unknown) => Array.isArray(v) ? v.length > 0 : typeof v === 'object' && v !== null ? Object.keys(v).length > 0 : !!v && v !== '0';

interface Node { kind: 'text' | 'var' | 'if' | 'unless' | 'each'; text?: string; path?: string; body?: Node[]; other?: Node[] }

function parse(src: string): Node[] {
  // Drop lines that hold only a block tag, so they leave no blank line behind.
  const cleaned = src.replace(/^[ \t]*(\{\{(?:#if|#unless|#each|else|\/if|\/unless|\/each)[^}]*\}\})[ \t]*\r?\n/gm, '$1');
  const tokens = cleaned.split(/(\{\{[^}]+\}\})/g);
  let i = 0;
  function block(stop: string[]): { nodes: Node[]; ended: string } {
    const nodes: Node[] = [];
    while (i < tokens.length) {
      const t = tokens[i++];
      const m = /^\{\{\s*(#if|#unless|#each|else|\/if|\/unless|\/each)?\s*([^}]*?)\s*\}\}$/.exec(t);
      if (!m) { if (t) nodes.push({ kind: 'text', text: t }); continue; }
      const [, tag, arg] = m;
      if (!tag) { nodes.push({ kind: 'var', path: arg }); continue; }
      if (stop.includes(tag)) return { nodes, ended: tag };
      if (tag === 'else' || tag.startsWith('/')) throw new Error(`Unexpected {{${tag}}} in template`);
      const kind = tag.slice(1) as 'if' | 'unless' | 'each';
      const inner = block(kind === 'each' ? ['/each'] : kind === 'if' ? ['else', '/if'] : ['/unless']);
      const node: Node = { kind, path: arg, body: inner.nodes };
      if (inner.ended === 'else') node.other = block(['/if']).nodes;
      nodes.push(node);
    }
    if (stop.length) throw new Error(`Missing {{${stop[stop.length - 1]}}} in template`);
    return { nodes, ended: '' };
  }
  return block([]).nodes;
}

function run(nodes: Node[], ctx: Ctx): string {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') out += n.text;
    else if (n.kind === 'var') { const v = lookup(n.path!, ctx); out += v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }
    else if (n.kind === 'if') out += run(truthy(lookup(n.path!, ctx)) ? n.body! : n.other ?? [], ctx);
    else if (n.kind === 'unless') out += truthy(lookup(n.path!, ctx)) ? '' : run(n.body!, ctx);
    else {
      const list = lookup(n.path!, ctx);
      if (Array.isArray(list)) list.forEach((item, index) => { out += run(n.body!, { root: ctx.root, item, index, length: list.length }); });
    }
  }
  return out;
}

export function render(template: string, data: unknown): string {
  return run(parse(template), { root: data });
}
