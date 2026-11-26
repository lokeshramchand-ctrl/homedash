// Defence in depth for the SQL consoles. The real control is a database login that only has read
// permissions; these checks only stop a read-only console from being talked out of its transaction.

/** Replaces string literals, quoted identifiers and comments with spaces so keyword checks cannot be fooled by them. */
export function stripSqlNoise(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    if (c === '-' && d === '-') { while (i < n && sql[i] !== '\n') i++; out += ' '; continue; }
    if (c === '/' && d === '*') { // T-SQL and PostgreSQL both nest block comments; MySQL does not, so be strict: nest.
      let depth = 1; i += 2;
      while (i < n && depth > 0) { if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; } else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; } else i++; }
      out += ' '; continue;
    }
    if (c === '$') { // PostgreSQL dollar quoting: $tag$ ... $tag$
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) { const end = sql.indexOf(m[0], i + m[0].length); i = end === -1 ? n : end + m[0].length; out += ' '; continue; }
    }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      const backslash = c !== '[' && (c === "'" || c === '"') && /[eE]$/.test(out.trimEnd().slice(-1)) ? true : false; // E'..' escapes
      i++;
      while (i < n) {
        if (backslash && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === close) { if (sql[i + 1] === close) { i += 2; continue; } break; }
        i++;
      }
      i++; out += ' '; continue;
    }
    out += c; i++;
  }
  return out;
}

/** True when the text holds more than one statement (a semicolon followed by anything but whitespace). */
export function hasMultipleStatements(sql: string): boolean {
  const s = stripSqlNoise(sql);
  const first = s.indexOf(';');
  return first !== -1 && s.slice(first + 1).replace(/[\s;]+/g, '') !== '';
}

// Statements that end or escape the read-only transaction, or that SQL Server cannot roll back.
const MSSQL_FORBIDDEN_IN_READONLY = new RegExp(
  '\\b(commit|rollback|save\\s+tran(saction)?|begin\\s+(distributed\\s+)?tran(saction)?|set\\s+implicit_transactions|' +
  'xp_cmdshell|xp_regwrite|xp_dirtree|xp_fileexist|sp_configure|sp_oacreate|sp_oamethod|reconfigure|openrowset|opendatasource|bulk\\s+insert|' +
  'backup|restore|kill|shutdown|dbcc|alter\\s+(database|server)|create\\s+database|drop\\s+database|waitfor\\s+delay)\\b', 'i');

/** Returns the offending keyword when a read-only T-SQL console must refuse this text, else null. */
export function mssqlReadOnlyViolation(sql: string): string | null {
  const m = MSSQL_FORBIDDEN_IN_READONLY.exec(stripSqlNoise(sql));
  return m ? m[0].replace(/\s+/g, ' ').toUpperCase() : null;
}
