/**
 * Serialização JSON determinística para hashing.
 *
 * Algoritmo (documentado para o desafio):
 *  1. as chaves de objeto são ordenadas lexicograficamente (padrão do
 *     `Array.prototype.sort`, ou seja, ordem de code-unit UTF-16), recursivamente;
 *  2. arrays mantêm a ordem;
 *  3. membros de objeto `undefined` são descartados (`JSON.stringify` padrão);
 *  4. sem espaço em branco insignificante (separadores padrão do `JSON.stringify`);
 *  5. a string é codificada como UTF-8 ao ser passada para o hash.
 *
 * O subconjunto de campos alimentado aqui é sempre dado simples (strings /
 * `null`), então não há ambiguidade de formatação numérica.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortDeep(source[key]);
    }
    return sorted;
  }
  return value;
}
