/**
 * Visão estrutural mínima da resposta HTTP, para que os controllers e o
 * exception filter definam um código de status dinâmico sem depender de
 * `@types/express`.
 */
export interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}
